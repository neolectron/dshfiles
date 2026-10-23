import { useState } from 'react'
import type { BotAdapterInfo } from '@dshfiles/bots/adapter'
import { Button } from '@dshfiles/plugin-ui/components/ui/button'
import { Checkbox } from '@dshfiles/plugin-ui/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@dshfiles/plugin-ui/components/ui/dialog'
import { useMutation, useQueryClient } from '@dshfiles/plugin-ui/query'
import { botsKeys, type BotsClient } from './bots-queries.js'
import type { BotConnection } from './contract.js'

/** The grant is Host state; only the unopened/unaccepted consent dialog belongs to this view. */
export const BotsCredentialManagement = (props: {
  readonly api: BotsClient
  readonly connection: BotConnection
  readonly adapter: BotAdapterInfo | undefined
  readonly busy: boolean
}): JSX.Element | null => {
  const [open, setOpen] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => {
      const input: Parameters<BotsClient['setCredentialManagement']>[0] = { connectionId: props.connection.id, enabled }
      if (enabled) input.acceptRisks = true
      return props.api.setCredentialManagement(input)
    },
    retry: false,
    onSuccess: () => {
      setOpen(false)
      setAccepted(false)
      void client.invalidateQueries({ queryKey: botsKeys.all })
    },
  })
  const granted = props.connection.credentialManagement === true
  const metadata = props.adapter?.credentialManagement
  if (!granted && metadata === undefined) return null
  const pending = props.busy || mutation.isPending
  return (
    <section aria-label="Credential management" className="dshx:space-y-2">
      <p className="dshx:text-xs dshx:text-muted-foreground">
        {granted ? 'Managed credential references enabled.' : 'Manual credential references. Automatic vault saves are not granted.'} Revoking stops new saves;
        an already accepted vault call may finish. References, vault credentials and local data are retained.
      </p>
      <Button
        disabled={pending}
        size="sm"
        variant="outline"
        onClick={() => {
          mutation.reset()
          if (granted) mutation.mutate(false)
          else {
            setAccepted(false)
            setOpen(true)
          }
        }}
      >
        {granted ? 'Revoke credential management' : 'Enable credential management…'}
      </Button>
      {mutation.isError && <p role="alert">Credential permission could not be changed. Check current status before retrying.</p>}
      {open && metadata !== undefined && (
        <Dialog
          open
          onOpenChange={value => {
            if (!mutation.isPending) {
              setOpen(value)
              setAccepted(false)
            }
          }}
        >
          <DialogContent className="dshx-root">
            <DialogHeader>
              <DialogTitle>Enable credential management?</DialogTitle>
              <DialogDescription>{metadata.description}</DialogDescription>
            </DialogHeader>
            <p className="dshx:text-sm">
              This additional grant permits adapter-managed vault saves and reference replacement for “{props.connection.label}”. No credential values enter
              Bots. Revocation is not a rollback of an already accepted vault call.
            </p>
            <label className="dshx:flex dshx:items-start dshx:gap-2 dshx:text-sm">
              <Checkbox checked={accepted} disabled={pending} onCheckedChange={value => setAccepted(value === true)} />
              {metadata.label}
            </label>
            <DialogFooter>
              <Button
                disabled={pending}
                variant="outline"
                onClick={() => {
                  setOpen(false)
                  setAccepted(false)
                }}
              >
                Cancel
              </Button>
              <Button disabled={pending || !accepted} onClick={() => mutation.mutate(true)}>
                Enable credential management
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
