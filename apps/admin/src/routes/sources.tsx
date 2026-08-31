import { isDefinedError } from '@newsdeck/api-client'
import {
  type CreateSourceInput,
  CreateSourceInputSchema,
  type Source,
  type UpdateSourceInput,
  UpdateSourceInputSchema,
} from '@newsdeck/api-contract'
import { Panel, StatusBadge, statusTone } from '@newsdeck/ui'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { FormEvent } from 'react'
import { Suspense, useState } from 'react'
import { orpc } from '~/lib/api.ts'

/** Matches the repository default (`apps/api/src/modules/sources/repository.ts`) so the count of pages this page shows lines up with what the server actually returns. */
const PAGE_SIZE = 20

type SourceFieldErrors = Partial<Record<'name' | 'feedUrl' | 'siteUrl', string>>

/** Shape a zod issue list has in common across schema versions — avoids depending on `zod`'s types directly. */
interface FieldIssue {
  path: readonly PropertyKey[]
  message: string
}

/** Groups a zod validation failure by the offending field, keeping the first message per field. */
export function fieldErrorsFrom(issues: readonly FieldIssue[]): SourceFieldErrors {
  const errors: SourceFieldErrors = {}
  for (const issue of issues) {
    const key = issue.path[0]
    if (key === 'name' || key === 'feedUrl' || key === 'siteUrl') {
      errors[key] ??= issue.message
    }
  }
  return errors
}

/** `''` means "not provided" in a form; the contract wants `null` or omission instead. */
export function normalizeSiteUrl(value: string): string | null {
  return value.trim() === '' ? null : value
}

/** TanStack Query bindings for the `sources` procedures. Tests supply bindings built from a fake client, mirroring `LoadBalancingProbe`. */
type SourcesOrpc = typeof orpc.sources

export const Route = createFileRoute('/sources')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      orpc.sources.list.queryOptions({ input: { page: 1, pageSize: PAGE_SIZE } }),
    ),
  component: SourcesPage,
})

function SourcesPage() {
  return (
    <>
      <CreateSourceForm />
      <Suspense
        fallback={
          <Panel title="Sources">
            <p className="nd-note">Loading…</p>
          </Panel>
        }
      >
        <SourcesTable />
      </Suspense>
    </>
  )
}

export interface CreateSourceFormProps {
  /** Defaults to the app's real oRPC bindings. Tests supply a fake. */
  sourcesOrpc?: SourcesOrpc
}

export function CreateSourceForm({ sourcesOrpc = orpc.sources }: CreateSourceFormProps = {}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [fieldErrors, setFieldErrors] = useState<SourceFieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  const create = useMutation(
    sourcesOrpc.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: sourcesOrpc.list.key() })
        setName('')
        setFeedUrl('')
        setSiteUrl('')
        setFieldErrors({})
        setFormError(null)
      },
      onError: (error) => {
        if (isDefinedError(error) && error.code === 'CONFLICT') {
          setFieldErrors({ feedUrl: 'A source with this feed URL already exists.' })
          setFormError(null)
          return
        }
        setFieldErrors({})
        setFormError('Could not add the source. Try again.')
      },
    }),
  )

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const result = CreateSourceInputSchema.safeParse({
      name,
      feedUrl,
      siteUrl: normalizeSiteUrl(siteUrl),
    } satisfies CreateSourceInput)

    if (!result.success) {
      setFieldErrors(fieldErrorsFrom(result.error.issues))
      setFormError(null)
      return
    }

    setFieldErrors({})
    setFormError(null)
    create.mutate(result.data)
  }

  return (
    <Panel title="Add source" description="Register a new feed for the collector to read.">
      <form className="nd-form" onSubmit={handleSubmit}>
        <label className="nd-field" htmlFor="source-name">
          <span>Name</span>
          <input
            id="source-name"
            className="nd-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {fieldErrors.name === undefined ? null : (
            <p className="nd-field__error">{fieldErrors.name}</p>
          )}
        </label>
        <label className="nd-field" htmlFor="source-feed-url">
          <span>Feed URL</span>
          <input
            id="source-feed-url"
            className="nd-input"
            value={feedUrl}
            onChange={(event) => setFeedUrl(event.target.value)}
          />
          {fieldErrors.feedUrl === undefined ? null : (
            <p className="nd-field__error">{fieldErrors.feedUrl}</p>
          )}
        </label>
        <label className="nd-field" htmlFor="source-site-url">
          <span>Site URL (optional)</span>
          <input
            id="source-site-url"
            className="nd-input"
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
          />
          {fieldErrors.siteUrl === undefined ? null : (
            <p className="nd-field__error">{fieldErrors.siteUrl}</p>
          )}
        </label>
        {formError === null ? null : <p className="nd-form__error">{formError}</p>}
        <button type="submit" className="nd-button" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add source'}
        </button>
      </form>
    </Panel>
  )
}

interface SourcesTableProps {
  /** Defaults to the app's real oRPC bindings. Tests supply a fake. */
  sourcesOrpc?: SourcesOrpc
}

function SourcesTable({ sourcesOrpc = orpc.sources }: SourcesTableProps = {}) {
  const [page, setPage] = useState(1)
  const { data } = useSuspenseQuery(
    sourcesOrpc.list.queryOptions({ input: { page, pageSize: PAGE_SIZE } }),
  )
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

  return (
    <Panel title="Sources" description={`${data.total} configured.`}>
      {data.items.length === 0 ? (
        <p className="nd-note">No sources yet. Add one above.</p>
      ) : (
        <table className="nd-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Feed URL</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((source) => (
              <SourceRow key={source.id} source={source} sourcesOrpc={sourcesOrpc} />
            ))}
          </tbody>
        </table>
      )}
      <div className="nd-pagination">
        <button
          type="button"
          className="nd-button"
          onClick={() => setPage((current) => current - 1)}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="nd-button"
          onClick={() => setPage((current) => current + 1)}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </div>
    </Panel>
  )
}

export interface SourceRowProps {
  source: Source
  /** Defaults to the app's real oRPC bindings. Tests supply a fake. */
  sourcesOrpc?: SourcesOrpc
}

export function SourceRow({ source, sourcesOrpc = orpc.sources }: SourceRowProps) {
  const queryClient = useQueryClient()
  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState(source.name)
  const [feedUrl, setFeedUrl] = useState(source.feedUrl)
  const [siteUrl, setSiteUrl] = useState(source.siteUrl ?? '')
  const [fieldErrors, setFieldErrors] = useState<SourceFieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: sourcesOrpc.list.key() })

  const update = useMutation(
    sourcesOrpc.update.mutationOptions({
      onSuccess: () => {
        invalidateList()
        setIsEditing(false)
        setFieldErrors({})
        setFormError(null)
      },
      onError: (error) => {
        if (isDefinedError(error) && error.code === 'CONFLICT') {
          setFieldErrors({ feedUrl: 'A source with this feed URL already exists.' })
          setFormError(null)
          return
        }
        setFieldErrors({})
        setFormError('Could not save the source. Try again.')
      },
    }),
  )

  const deactivate = useMutation(
    sourcesOrpc.deactivate.mutationOptions({
      onSuccess: () => {
        invalidateList()
        setFormError(null)
      },
      onError: () => {
        setFormError('Could not deactivate the source. Try again.')
      },
    }),
  )

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const result = UpdateSourceInputSchema.safeParse({
      id: source.id,
      name,
      feedUrl,
      siteUrl: normalizeSiteUrl(siteUrl),
    } satisfies UpdateSourceInput)

    if (!result.success) {
      setFieldErrors(fieldErrorsFrom(result.error.issues))
      setFormError(null)
      return
    }

    setFieldErrors({})
    setFormError(null)
    update.mutate(result.data)
  }

  function handleCancel() {
    setName(source.name)
    setFeedUrl(source.feedUrl)
    setSiteUrl(source.siteUrl ?? '')
    setFieldErrors({})
    setFormError(null)
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <tr>
        <td colSpan={4}>
          <form className="nd-form nd-form--inline" onSubmit={handleSave}>
            <label className="nd-field" htmlFor={`source-name-${source.id}`}>
              <span>Name</span>
              <input
                id={`source-name-${source.id}`}
                className="nd-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              {fieldErrors.name === undefined ? null : (
                <p className="nd-field__error">{fieldErrors.name}</p>
              )}
            </label>
            <label className="nd-field" htmlFor={`source-feed-url-${source.id}`}>
              <span>Feed URL</span>
              <input
                id={`source-feed-url-${source.id}`}
                className="nd-input"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
              />
              {fieldErrors.feedUrl === undefined ? null : (
                <p className="nd-field__error">{fieldErrors.feedUrl}</p>
              )}
            </label>
            <label className="nd-field" htmlFor={`source-site-url-${source.id}`}>
              <span>Site URL</span>
              <input
                id={`source-site-url-${source.id}`}
                className="nd-input"
                value={siteUrl}
                onChange={(event) => setSiteUrl(event.target.value)}
              />
              {fieldErrors.siteUrl === undefined ? null : (
                <p className="nd-field__error">{fieldErrors.siteUrl}</p>
              )}
            </label>
            {formError === null ? null : <p className="nd-form__error">{formError}</p>}
            <div className="nd-row-actions">
              <button type="submit" className="nd-button" disabled={update.isPending}>
                {update.isPending ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="nd-button" onClick={handleCancel}>
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td>{source.name}</td>
      <td>{source.feedUrl}</td>
      <td>
        <StatusBadge tone={statusTone(source.isActive)}>
          {source.isActive ? 'active' : 'inactive'}
        </StatusBadge>
      </td>
      <td>
        <div className="nd-row-actions">
          <button type="button" className="nd-button" onClick={() => setIsEditing(true)}>
            Edit
          </button>
          {source.isActive ? (
            <button
              type="button"
              className="nd-button"
              onClick={() => deactivate.mutate({ id: source.id })}
              disabled={deactivate.isPending}
            >
              {deactivate.isPending ? 'Deactivating…' : 'Deactivate'}
            </button>
          ) : null}
        </div>
        {formError === null ? null : <p className="nd-form__error">{formError}</p>}
      </td>
    </tr>
  )
}
