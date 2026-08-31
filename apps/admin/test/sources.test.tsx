import { afterEach, describe, expect, it } from 'bun:test'
import { ORPCError } from '@newsdeck/api-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  CreateSourceForm,
  fieldErrorsFrom,
  normalizeSiteUrl,
  SourceRow,
} from '../src/routes/sources.tsx'
import { fakeSource, fakeSourcesOrpc } from './support/fakeSourcesOrpc.ts'

afterEach(cleanup)

function withQueryClient(children: ReactNode) {
  const queryClient = new QueryClient()
  return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>)
}

function conflictError(feedUrl: string) {
  return new ORPCError('CONFLICT', {
    message: 'a source with this feed url already exists',
    data: { feedUrl },
    defined: true,
  })
}

describe('fieldErrorsFrom', () => {
  it('keeps the first message per recognised field', () => {
    const errors = fieldErrorsFrom([
      { path: ['feedUrl'], message: 'Invalid url' },
      { path: ['feedUrl'], message: 'a later issue on the same field is dropped' },
      { path: ['name'], message: 'Required' },
    ])

    expect(errors).toEqual({ feedUrl: 'Invalid url', name: 'Required' })
  })

  it('ignores issues on fields the form does not render', () => {
    expect(fieldErrorsFrom([{ path: ['unknownField'], message: 'ignored' }])).toEqual({})
  })

  it('returns no errors for an empty issue list', () => {
    expect(fieldErrorsFrom([])).toEqual({})
  })
})

describe('normalizeSiteUrl', () => {
  it('turns blank or whitespace-only input into null', () => {
    expect(normalizeSiteUrl('')).toBeNull()
    expect(normalizeSiteUrl('   ')).toBeNull()
  })

  it('passes non-blank input through unchanged', () => {
    expect(normalizeSiteUrl('https://example.test')).toBe('https://example.test')
  })
})

function fillCreateForm(feedUrl: string, name = 'A source') {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Feed URL'), { target: { value: feedUrl } })
}

describe('CreateSourceForm', () => {
  it('shows field validation errors and never calls the API for invalid input', () => {
    let calls = 0
    const create = async () => {
      calls += 1
      return fakeSource()
    }
    const { container } = withQueryClient(
      <CreateSourceForm sourcesOrpc={fakeSourcesOrpc({ create })} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add source' }))

    expect(container.querySelectorAll('.nd-field__error').length).toBeGreaterThan(0)
    expect(calls).toBe(0)
  })

  it('maps a CONFLICT error to the feed url field', async () => {
    const create = async () => {
      throw conflictError('https://example.test/feed.xml')
    }
    withQueryClient(<CreateSourceForm sourcesOrpc={fakeSourcesOrpc({ create })} />)

    fillCreateForm('https://example.test/feed.xml')
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }))

    expect(await screen.findByText('A source with this feed URL already exists.')).toBeDefined()
  })

  it('shows a generic error for a non-conflict failure', async () => {
    const create = async () => {
      throw new Error('network down')
    }
    withQueryClient(<CreateSourceForm sourcesOrpc={fakeSourcesOrpc({ create })} />)

    fillCreateForm('https://example.test/feed.xml')
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }))

    expect(await screen.findByText('Could not add the source. Try again.')).toBeDefined()
  })

  it('clears the form on a successful create', async () => {
    const create = async () => fakeSource()
    withQueryClient(<CreateSourceForm sourcesOrpc={fakeSourcesOrpc({ create })} />)

    fillCreateForm('https://example.test/feed.xml')
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }))

    await screen.findByRole('button', { name: 'Add source' })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
  })
})

describe('SourceRow', () => {
  it('shows a failure message when deactivate fails', async () => {
    const deactivate = async () => {
      throw new Error('network down')
    }
    withQueryClient(
      <table>
        <tbody>
          <SourceRow source={fakeSource()} sourcesOrpc={fakeSourcesOrpc({ deactivate })} />
        </tbody>
      </table>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

    expect(await screen.findByText('Could not deactivate the source. Try again.')).toBeDefined()
  })

  it('clears a previous deactivate failure once the retry succeeds', async () => {
    let shouldFail = true
    const deactivate = async () => {
      if (shouldFail) {
        shouldFail = false
        throw new Error('network down')
      }
      return fakeSource({ isActive: false })
    }
    withQueryClient(
      <table>
        <tbody>
          <SourceRow source={fakeSource()} sourcesOrpc={fakeSourcesOrpc({ deactivate })} />
        </tbody>
      </table>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await screen.findByText('Could not deactivate the source. Try again.')

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

    await waitFor(() => {
      expect(screen.queryByText('Could not deactivate the source. Try again.')).toBeNull()
    })
  })

  it('maps a CONFLICT error from update to the feed url field', async () => {
    const update = async () => {
      throw conflictError('https://example.test/feed.xml')
    }
    withQueryClient(
      <table>
        <tbody>
          <SourceRow source={fakeSource()} sourcesOrpc={fakeSourcesOrpc({ update })} />
        </tbody>
      </table>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('A source with this feed URL already exists.')).toBeDefined()
  })
})
