import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { ErrorPanel } from './components/ErrorPanel.tsx'
import { NotFound } from './components/NotFound.tsx'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  // One QueryClient per request on the server, one per tab in the browser.
  // Sharing a client across requests would leak one visitor's data into
  // another's SSR output.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
      },
    },
  })

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultErrorComponent: ErrorPanel,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  })

  // Dehydrates the query cache into the SSR payload and rehydrates it in the
  // browser, so data fetched on the server is not fetched a second time.
  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
