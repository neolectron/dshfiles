import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'
import { BotsStorage, STORAGE_FAILED, type BotsState } from './store.js'

const deferred = () => {
  let resolve: () => void = () => {
    throw new Error('Fixture deferred is not ready')
  }
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const tableFixture = () => {
  const rows = new Map<string, BotsState>()
  let beforePut = async (_state: BotsState): Promise<void> => undefined
  let putCount = 0
  const table: KvTable<string, BotsState> = {
    get: key => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() {
      return rows.size
    },
    put: async (key, state) => {
      putCount++
      await beforePut(state)
      rows.set(key, structuredClone(state))
    },
    delete: async key => rows.delete(key),
    update: async (key, change) => {
      const current = rows.get(key)
      if (current === undefined) throw new Error('Fixture row is missing')
      const next = change(current)
      await table.put(key, next)
      return next
    },
  }
  return {
    table,
    rows,
    putCount: () => putCount,
    beforePut: (operation: typeof beforePut) => {
      beforePut = operation
    },
  }
}

describe('serialized durable Bots store', () => {
  it('serializes read-modify-write and publishes neither result nor state before durable completion', async () => {
    const disk = tableFixture()
    const store = BotsStorage.create(disk.table, () => 100)
    const entered = deferred()
    const durable = deferred()
    disk.beforePut(async () => {
      entered.resolve()
      if (disk.putCount() === 1) await durable.promise
    })
    let secondEntered = false
    let acknowledged = false
    const first = store
      .change(state => ++state.nextSequence)
      .then(result => {
        acknowledged = true
        return result
      })
    const second = store.change(state => {
      secondEntered = true
      return ++state.nextSequence
    })
    await entered.promise
    try {
      expect(store.read().nextSequence).toBe(1)
      expect(secondEntered).toBe(false)
      expect(acknowledged).toBe(false)
    } finally {
      durable.resolve()
    }
    expect(await first).toBe(2)
    expect(await second).toBe(3)
    expect(store.read().nextSequence).toBe(3)
    expect(store.read().revision).toBe(101)
    expect(BotsStorage.create(disk.table, () => 1).read()).toEqual(store.read())
  })

  it('fails closed after an ambiguous backend error and cannot overwrite it with a stale state', async () => {
    const disk = tableFixture()
    const store = BotsStorage.create(disk.table)
    disk.beforePut(async () => {
      throw new Error('DO_NOT_LEAK_BACKEND_FIXTURE')
    })
    await expect(store.change(state => ++state.nextSequence)).rejects.toThrow(STORAGE_FAILED)
    expect(store.failed).toBe(true)
    expect(store.read().nextSequence).toBe(1)
    disk.beforePut(async () => undefined)
    await expect(store.change(state => ++state.nextSequence)).rejects.toThrow(STORAGE_FAILED)
    expect(disk.putCount()).toBe(1)
    await store.flush()
  })

  it('does not let a caller mutate authoritative state or resurrect unpersisted changes', async () => {
    const disk = tableFixture()
    const store = BotsStorage.create(disk.table)
    await store.change(state => {
      state.nextSequence = 20
    })
    const read = store.read()
    read.nextSequence = 999
    expect(store.read().nextSequence).toBe(20)
    expect(BotsStorage.create(disk.table).read().nextSequence).toBe(20)
    await expect(
      store.change(state => {
        state.nextSequence = -1
      }),
    ).rejects.toThrow('storage boundary')
    expect(store.read().nextSequence).toBe(20)
    expect(store.failed).toBe(false)
    await store.change(state => ++state.nextSequence)
    expect(store.read().nextSequence).toBe(21)
  })

  it('rejects corrupt stored state without dumping its contents into an error', async () => {
    const disk = tableFixture()
    const store = BotsStorage.create(disk.table)
    const state = store.read()
    state.revision = Number.NaN
    disk.rows.set('current', state)
    expect(() => BotsStorage.create(disk.table)).toThrow('could not be loaded safely')
  })
})
