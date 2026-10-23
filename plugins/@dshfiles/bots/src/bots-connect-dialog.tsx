import { Button } from '@dshfiles/plugin-ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@dshfiles/plugin-ui/components/ui/dialog'
import { Input } from '@dshfiles/plugin-ui/components/ui/input'
import { fieldErrorMessages, revalidateLogic, useAppForm } from '@dshfiles/plugin-ui/form'
import { ShieldCheckIcon } from '@dshfiles/plugin-ui/icons'
import { useId, useState } from 'react'
import type { BotAdapterInfo } from '@dshfiles/bots/adapter'
import type { BotConnectInput } from './contract.js'
import { BotsUiModel } from './bots-ui-model.js'

interface ConnectProps {
  readonly adapters: readonly BotAdapterInfo[]
  readonly pending: boolean
  readonly failed: boolean
  readonly onConnect: (input: BotConnectInput) => void
  readonly onClose: () => void
}

const AdapterForm = (props: ConnectProps & { readonly adapter: BotAdapterInfo }): JSX.Element => {
  const id = useId()
  const form = useAppForm({
    defaultValues: BotsUiModel.connectDefaults(props.adapter),
    validationLogic: revalidateLogic({ mode: 'change', modeAfterSubmission: 'change' }),
    validators: { onDynamic: BotsUiModel.connectFormSchema(props.adapter) },
    onSubmit: ({ value }) => {
      props.onConnect(BotsUiModel.connectInput(props.adapter, value))
    },
  })
  return (
    <form
      className="dshx:flex dshx:flex-col dshx:gap-5"
      onSubmit={event => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <p className="dshx:text-sm dshx:text-muted-foreground">{props.adapter.description}</p>
      <form.AppField name="label">{field => <field.TextField label="Connection name" required />}</form.AppField>
      {props.adapter.fields.map((metadata, index) => (
        <form.Field key={metadata.key} name={`fields[${index}].value`}>
          {field => {
            const errors = field.state.meta.isTouched || form.state.submissionAttempts > 0 ? fieldErrorMessages(field.state.meta.errors) : []
            const fieldId = `${id}-${index}`
            return (
              <div className="dshx:grid dshx:gap-2">
                <label className="dshx:text-sm dshx:font-medium" htmlFor={fieldId}>
                  {metadata.label}
                  {metadata.required && <span aria-hidden> *</span>}
                </label>
                <Input
                  aria-describedby={`${fieldId}-help ${fieldId}-error`}
                  aria-invalid={errors.length > 0}
                  autoComplete="off"
                  data-secret-input={metadata.kind === 'secret-reference' ? 'reference' : undefined}
                  disabled={props.pending}
                  id={fieldId}
                  maxLength={4096}
                  name={metadata.key}
                  onBlur={field.handleBlur}
                  onChange={event => field.handleChange(event.currentTarget.value)}
                  placeholder={metadata.kind === 'secret-reference' ? 'secret:ALIAS' : undefined}
                  required={metadata.required}
                  spellCheck={false}
                  value={field.state.value}
                />
                <p className="dshx:text-xs dshx:text-muted-foreground" id={`${fieldId}-help`}>
                  {metadata.help}
                  {metadata.kind === 'secret-reference' && ' Enter a vault reference, never the credential itself.'}
                </p>
                <p className="dshx:text-xs dshx:text-destructive" id={`${fieldId}-error`}>
                  {errors.join(' ')}
                </p>
              </div>
            )
          }}
        </form.Field>
      ))}
      <section aria-label="Connection risks" className="dshx:space-y-3 dshx:rounded-lg dshx:border dshx:bg-muted/30 dshx:p-4">
        <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-sm dshx:font-medium">
          <ShieldCheckIcon aria-hidden className="dshx:size-4" /> Before you connect
        </div>
        <p className="dshx:whitespace-pre-wrap dshx:text-sm">{props.adapter.risk}</p>
        <p className="dshx:text-xs dshx:text-muted-foreground">
          This links an existing remote bot. All admitted DSH browsers share access to its cached conversations. No DSH thread, model or replacement bot is
          created.
        </p>
        <form.AppField name="accepted">{field => <field.CheckboxField label="I understand and accept these connection risks" />}</form.AppField>
      </section>
      {props.failed && (
        <p className="dshx:text-sm dshx:text-destructive" role="alert">
          Could not connect. Check the adapter and vault references, then try again. Credential values are never shown here.
        </p>
      )}
      <div className="dshx:flex dshx:justify-end dshx:gap-2">
        <Button disabled={props.pending} onClick={props.onClose} type="button" variant="outline">
          Cancel
        </Button>
        <form.AppForm>
          <form.Subscribe selector={state => state.values.accepted}>
            {accepted => <form.SubmitButton disabled={props.pending || !accepted}>{props.pending ? 'Connecting…' : 'Connect existing bot'}</form.SubmitButton>}
          </form.Subscribe>
        </form.AppForm>
      </div>
    </form>
  )
}

export const BotsConnectDialog = (props: ConnectProps): JSX.Element => {
  const [adapterId, setAdapterId] = useState(props.adapters[0]?.id ?? '')
  const adapter = props.adapters.find(item => item.id === adapterId)
  const selectId = useId()
  return (
    <Dialog
      onOpenChange={open => {
        if (!open && !props.pending) props.onClose()
      }}
      open
    >
      <DialogContent className="dshx-root dshx:max-h-[90dvh] dshx:overflow-y-auto dshx:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect bot</DialogTitle>
          <DialogDescription>Bring an existing durable bot into your workspace.</DialogDescription>
        </DialogHeader>
        {props.adapters.length === 0 ? (
          <div className="dshx:space-y-4">
            <p className="dshx:text-sm dshx:text-muted-foreground">
              No bot adapters are available. Install and enable a compatible provider adapter before connecting.
            </p>
            <Button onClick={props.onClose} variant="outline">
              Close
            </Button>
          </div>
        ) : (
          <>
            <div className="dshx:grid dshx:gap-2">
              <label className="dshx:text-sm dshx:font-medium" htmlFor={selectId}>
                Provider adapter
              </label>
              <select
                className="dshx:h-9 dshx:w-full dshx:min-w-0 dshx:rounded-md dshx:border dshx:border-input dshx:bg-background dshx:px-3 dshx:text-sm"
                disabled={props.pending}
                id={selectId}
                onChange={event => setAdapterId(event.currentTarget.value)}
                value={adapterId}
              >
                {props.adapters.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            {adapter === undefined ? (
              <p role="status">This adapter is unavailable. Reopen Connect bot.</p>
            ) : (
              <AdapterForm {...props} adapter={adapter} key={adapter.id} />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
