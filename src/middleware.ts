import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { readPlatformConfig } from '@/lib/platform/config'
import { requestHostname } from '@/lib/platform/hostname'
import {
  PlatformLookupError,
  type ProfileClient,
  forgetProfileAccount,
  lookupProfileAccountId,
  lookupTenant,
} from '@/lib/platform/tenant-lookup'
import {
  TENANT_HEADER_HOST,
  TENANT_HEADER_ID,
  classifyRequest,
  classifyTenant,
  needsAccountBinding,
  stripTenantHeaders,
  tenantLookupHost,
} from '@/lib/platform/tenant-routing'

// Protected pages - redirect to login if not authenticated
// Every top-level route under src/app/(dashboard)/ belongs here —
// middleware.test.ts reads that directory and fails on a missing one.
const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/flows', '/agents', '/notifications', '/settings']

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  const pathname = request.nextUrl.pathname
  const isApi = pathname.startsWith('/api/')

  // White-label: never trust tenant headers from the client. Built at the
  // END (after getUser() may have rewritten request cookies) so forwarded
  // headers carry the refreshed session.
  let tenantHeaders: { id: string; host: string } | null = null
  const forwardHeaders = () => {
    const h = stripTenantHeaders(request.headers)
    if (tenantHeaders) {
      h.set(TENANT_HEADER_ID, tenantHeaders.id)
      h.set(TENANT_HEADER_HOST, tenantHeaders.host)
    }
    return h
  }
  const redirectTo = (path: string, params: Record<string, string> = {}) => {
    const url = request.nextUrl.clone()
    url.pathname = path
    url.search = ''
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return withRefreshedCookies(NextResponse.redirect(url))
  }
  const rewriteTo = (path: string) => {
    const url = request.nextUrl.clone()
    url.pathname = path
    url.search = ''
    return withRefreshedCookies(NextResponse.rewrite(url, { request: { headers: forwardHeaders() } }))
  }
  // A DB error while resolving the tenant or the user's account is an
  // outage, not a verdict: never 404 or sign the user out because of it.
  const serviceUnavailable = () =>
    withRefreshedCookies(
      isApi
        ? NextResponse.json({ error: 'service_unavailable' }, { status: 503 })
        : new NextResponse('Service temporarily unavailable', { status: 503 })
    )

  // ---------------- White-label platform layer ----------------
  const cfg = readPlatformConfig()
  const host = requestHostname(request.headers)
  const kind = classifyRequest({ cfg, host, pathname })

  if (kind === 'admin') {
    if (pathname === '/signup') return redirectTo('/login')
    if (!user && pathname.startsWith('/admin')) return redirectTo('/login')
    if (user && (pathname === '/login' || protectedPaths.some(p => pathname.startsWith(p)))) {
      return redirectTo('/admin')
    }
  }

  if (kind === 'lookup') {
    const lookupHost = tenantLookupHost(cfg, host)
    let tenant
    try {
      tenant = lookupHost ? await lookupTenant(supabase, lookupHost) : null
    } catch (err) {
      if (err instanceof PlatformLookupError) return serviceUnavailable()
      throw err
    }
    const tenantKind = classifyTenant(tenant)

    if (tenantKind === 'not_found') {
      if (isApi) return withRefreshedCookies(NextResponse.json({ error: 'workspace_not_found' }, { status: 404 }))
      return rewriteTo('/workspace-not-found')
    }
    if (tenantKind === 'suspended') {
      if (isApi) return withRefreshedCookies(NextResponse.json({ error: 'workspace_suspended' }, { status: 403 }))
      return rewriteTo('/workspace-suspended')
    }

    tenantHeaders = { id: tenant!.accountId, host: lookupHost! }

    if (pathname === '/signup' && !request.nextUrl.searchParams.get('invite')) {
      return redirectTo('/login')
    }

    // Host↔account binding. Never on /join, /auth, /login, /signup,
    // /reset-password — a fresh invitee still has a temporary personal
    // account until redeem_invitation moves them (019).
    if (user && needsAccountBinding(pathname, protectedPaths)) {
      // The generated Supabase types are too deep for TS to match
      // structurally against ProfileClient (TS2589); cast once here.
      const profileDb = supabase as unknown as ProfileClient
      let accountId
      try {
        accountId = await lookupProfileAccountId(profileDb, user.id)
        if (accountId !== tenant!.accountId) {
          // Cached value may predate an invite redeem — re-read once.
          forgetProfileAccount(user.id)
          accountId = await lookupProfileAccountId(profileDb, user.id)
        }
      } catch (err) {
        if (err instanceof PlatformLookupError) return serviceUnavailable()
        throw err
      }
      if (accountId !== tenant!.accountId) {
        await supabase.auth.signOut()
        if (isApi) return withRefreshedCookies(NextResponse.json({ error: 'wrong_workspace' }, { status: 403 }))
        return redirectTo('/login', { error: 'wrong_workspace' })
      }
    }
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return withRefreshedCookies(NextResponse.next({ request: { headers: forwardHeaders() } }))
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
