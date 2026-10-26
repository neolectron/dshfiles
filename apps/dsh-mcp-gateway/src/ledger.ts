import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { GatewayError } from './contracts.js'

const taskRow = z.object({
  id: z.string(),
  principal: z.string(),
  project: z.string(),
  title: z.string(),
  session_id: z.string(),
  session_known: z.number(),
  admission: z.enum(['accepted', 'unknown', 'refused']),
  diagnostic: z.string().nullable(),
  created_at: z.number(),
  cancel_requested: z.number(),
})
const operationRow = z.object({
  principal: z.string(),
  key: z.string(),
  hash: z.string(),
  action: z.enum(['create', 'send', 'cancel']),
  task_id: z.string(),
  request_id: z.string(),
  phase: z.string(),
  status: z.enum(['pending', 'ack', 'unknown', 'refused']),
  diagnostic: z.string().nullable(),
})
type TaskRow = z.infer<typeof taskRow>
type OperationRow = z.infer<typeof operationRow>
interface LedgerClaim {
  readonly fresh: boolean
  readonly operation: OperationRow
}

// The private parent prevents untrusted path replacement between the fd checks
// and SQLite's own path-based open. Never chmod somebody else's shared folder.
function privateFile(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new GatewayError('invalid-config')
  const directory = dirname(path)
  let ancestor = parse(directory).root
  for (const part of directory.slice(ancestor.length).split('/').filter(Boolean)) {
    ancestor = join(ancestor, part)
    try {
      mkdirSync(ancestor, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    const info = lstatSync(ancestor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GatewayError('invalid-config')
    // Shared sticky ancestors such as /tmp are safe against another user's
    // rename; non-sticky writable ancestors would defeat the private leaf.
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) throw new GatewayError('invalid-config')
    if (info.uid !== 0 && info.uid !== process.getuid?.()) throw new GatewayError('invalid-config')
  }
  const parent = lstatSync(directory)
  if ((parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.()) throw new GatewayError('invalid-config')
  let fd: number
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
  }
  try {
    const info = fstatSync(fd)
    const named = lstatSync(path)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== parent.uid || (info.mode & 0o777) !== 0o600 || info.ino !== named.ino || info.dev !== named.dev)
      throw new GatewayError('invalid-config')
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        const sidecar = lstatSync(`${path}${suffix}`)
        if (!sidecar.isFile() || sidecar.nlink !== 1 || sidecar.uid !== parent.uid || (sidecar.mode & 0o777) !== 0o600) throw new GatewayError('invalid-config')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Internal admission ledger; it never stores prompts, snapshots, or raw errors. */
export function openLedger(path: string) {
  let fd: number | undefined
  let db: DatabaseSync | undefined
  try {
    fd = privateFile(path)
    db = new DatabaseSync(path)
    const named = lstatSync(path)
    const pinned = fstatSync(fd)
    if (named.ino !== pinned.ino || named.dev !== pinned.dev || named.nlink !== 1) throw new GatewayError('invalid-config')
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL,
        session_id TEXT NOT NULL, session_known INTEGER NOT NULL DEFAULT 0,
        admission TEXT NOT NULL DEFAULT 'unknown', diagnostic TEXT, created_at INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS task_owner ON tasks(principal, id);
      CREATE TABLE IF NOT EXISTS operations (
        principal TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, action TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL,
        phase TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', diagnostic TEXT,
        PRIMARY KEY(principal, key)
      );`)
  } catch {
    db?.close()
    if (fd !== undefined) closeSync(fd)
    throw new GatewayError('invalid-config')
  }
  // oxlint-disable-next-line antislop/no-passthrough-variable -- Capture successful initialization before closures; the mutable failure-cleanup binding cannot retain this narrowing.
  const database = db
  // oxlint-disable-next-line antislop/no-passthrough-variable -- Keep the verified descriptor alive until this ledger closes, independent of initialization cleanup.
  const pinnedFd = fd
  function task(id: string) {
    const value = database.prepare('SELECT * FROM tasks WHERE id=?').get(id)
    return value ? taskRow.parse(value) : null
  }
  function operation(principal: string, key: string) {
    const value = database.prepare('SELECT * FROM operations WHERE principal=? AND key=?').get(principal, key)
    return value ? operationRow.parse(value) : null
  }
  return {
    task,
    operation,
    claim(value: OperationRow, creating?: TaskRow): LedgerClaim {
      database.exec('BEGIN IMMEDIATE')
      try {
        const existing = operation(value.principal, value.key)
        if (existing) {
          if (existing.hash !== value.hash) throw new GatewayError('idempotency-conflict')
          database.exec('COMMIT')
          return { fresh: false, operation: existing }
        }
        const count = z
          .object({ count: z.number() })
          .parse(database.prepare('SELECT COUNT(*) AS count FROM operations WHERE principal=?').get(value.principal)).count
        if (count >= 100_000) throw new GatewayError('busy')
        if (creating) {
          database
            .prepare(`INSERT INTO tasks(id,principal,project,title,session_id,session_known,admission,diagnostic,created_at,cancel_requested)
            VALUES(?,?,?,?,?,?,?,?,?,?)`)
            .run(
              creating.id,
              creating.principal,
              creating.project,
              creating.title,
              creating.session_id,
              creating.session_known,
              creating.admission,
              creating.diagnostic,
              creating.created_at,
              creating.cancel_requested,
            )
        }
        database
          .prepare('INSERT INTO operations(principal,key,hash,action,task_id,request_id,phase,status,diagnostic) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(value.principal, value.key, value.hash, value.action, value.task_id, value.request_id, value.phase, value.status, value.diagnostic)
        database.exec('COMMIT')
        return { fresh: true, operation: value }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    phase(op: OperationRow, phase: string) {
      database.prepare('UPDATE operations SET phase=? WHERE principal=? AND key=?').run(phase, op.principal, op.key)
    },
    finish(op: OperationRow, status: OperationRow['status'], diagnostic: string | null = null) {
      database.prepare('UPDATE operations SET status=?,diagnostic=? WHERE principal=? AND key=?').run(status, diagnostic, op.principal, op.key)
    },
    session(id: string, sessionId: string) {
      database.prepare('UPDATE tasks SET session_id=?,session_known=1 WHERE id=?').run(sessionId, id)
    },
    admission(id: string, admission: TaskRow['admission'], diagnostic: string | null) {
      database.prepare('UPDATE tasks SET admission=?,diagnostic=? WHERE id=?').run(admission, diagnostic, id)
    },
    cancellation(id: string) {
      database.prepare('UPDATE tasks SET cancel_requested=1 WHERE id=?').run(id)
    },
    list(principal: string, projects: readonly string[], limit: number, cursor?: string) {
      if (projects.length === 0) return []
      return database
        .prepare(`SELECT * FROM tasks WHERE principal=? AND project IN (${projects.map(() => '?').join(',')}) AND id>? ORDER BY id LIMIT ?`)
        .all(principal, ...projects, cursor ?? '', limit)
        .map(row => taskRow.parse(row))
    },
    close() {
      try {
        database.close()
      } finally {
        closeSync(pinnedFd)
      }
    },
  }
}
