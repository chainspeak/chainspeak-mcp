import { timingSafeEqual } from 'node:crypto'

type Fetcher = (req: Request) => Promise<Response>

const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
  })

const tokenMatches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const requireBearer =
  (token: string, inner: Fetcher): Fetcher =>
  (req) => {
    const auth = req.headers.get('authorization')
    const presented = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
    if (presented === null || !tokenMatches(presented, token)) {
      return Promise.resolve(unauthorized())
    }
    return inner(req)
  }
