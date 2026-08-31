/// <reference types="vite/client" />
import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Link, Scripts } from '@tanstack/react-router'
import type * as React from 'react'
import { ErrorPanel } from '~/components/ErrorPanel.tsx'
import { NotFound } from '~/components/NotFound.tsx'
import appCss from '~/styles/app.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Newsdeck Admin' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  errorComponent: ErrorPanel,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="nd-shell">
          <header className="nd-masthead">
            <div>
              <h1 className="nd-masthead__title">Newsdeck Admin</h1>
              <p className="nd-masthead__tagline">Platform operations</p>
            </div>
            <nav className="nd-nav">
              <Link to="/">Dashboard</Link>
              <Link to="/sources">Sources</Link>
            </nav>
          </header>
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  )
}
