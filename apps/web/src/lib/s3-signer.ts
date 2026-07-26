export interface S3Config {
  region: string
  endpoint?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  customDomain?: string
}

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function buf2hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function toBufferSource(data: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data as unknown as Uint8Array<ArrayBuffer>
  }
  const ab = new ArrayBuffer(data.byteLength)
  new Uint8Array(ab).set(data)
  return new Uint8Array(ab)
}

function strToBytes(s: string): Uint8Array<ArrayBuffer> {
  return toBufferSource(new TextEncoder().encode(s))
}

async function hashSha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return buf2hex(hash)
}

async function hmacSha256(keyBytes: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, data)
  return new Uint8Array(sig)
}

async function deriveSigningKey(
  dateStamp: string,
  secretAccessKey: string,
  region: string,
  service: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const kDate = await hmacSha256(strToBytes(`AWS4${secretAccessKey}`), strToBytes(dateStamp))
  const kRegion = await hmacSha256(kDate, strToBytes(region))
  const kService = await hmacSha256(kRegion, strToBytes(service))
  return await hmacSha256(kService, strToBytes('aws4_request'))
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d{3}/, '')
}

function canonicalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  const segments = pathname.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg)))
  let canonical = segments.join('/')
  if (!canonical.startsWith('/')) canonical = `/${canonical}`
  if (pathname.endsWith('/') && !canonical.endsWith('/')) canonical = `${canonical}/`
  return canonical
}

function buildCanonicalQuery(params: URLSearchParams): string {
  const entries: Array<{ key: string; value: string }> = []
  params.forEach((value, key) => {
    entries.push({ key: encodeURIComponent(key), value: encodeURIComponent(value) })
  })
  entries.sort((a, b) => (a.key === b.key ? a.value.localeCompare(b.value) : a.key.localeCompare(b.key)))
  return entries.map(({ key, value }) => `${key}=${value}`).join('&')
}

export interface SignedHeaders {
  [key: string]: string
  authorization: string
  'x-amz-content-sha256': string
  'x-amz-date': string
}

export async function signS3GetRequest(url: string, config: S3Config): Promise<SignedHeaders> {
  const parsedUrl = new URL(url)
  const now = new Date()
  const amzDate = toAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const service = 's3'
  const host = parsedUrl.host

  const canonicalUri = canonicalizePath(parsedUrl.pathname)
  const canonicalQuery = buildCanonicalQuery(parsedUrl.searchParams)
  const canonicalHeaders = `host:${host}\n`
  const signedHeaders = 'host'

  const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${EMPTY_HASH}`
  const credentialScope = `${dateStamp}/${config.region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await hashSha256(strToBytes(canonicalRequest))}`
  const signingKey = await deriveSigningKey(dateStamp, config.secretAccessKey, config.region, service)
  const signature = buf2hex((await hmacSha256(signingKey, strToBytes(stringToSign))).buffer)
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    authorization,
    'x-amz-content-sha256': EMPTY_HASH,
    'x-amz-date': amzDate,
  }
}

function isS3Url(url: string, config: S3Config): boolean {
  try {
    const parsed = new URL(url)
    if (config.customDomain && parsed.hostname === new URL(`https://${config.customDomain}`).hostname) return true
    if (config.bucket && parsed.hostname.startsWith(`${config.bucket}.s3`)) return true
    if (config.bucket && parsed.hostname.startsWith(`${config.bucket}.`)) return true
    if (config.endpoint && parsed.hostname === new URL(config.endpoint).hostname) return true
    if (config.endpoint && parsed.hostname.endsWith(`.${new URL(config.endpoint).hostname}`)) return true
    return false
  } catch {
    return false
  }
}

let cachedConfig: S3Config | null | undefined = undefined

function loadConfig(): S3Config | null {
  if (cachedConfig !== undefined) return cachedConfig
  if (typeof __S3_CONFIG__ !== 'undefined' && __S3_CONFIG__?.accessKeyId) {
    cachedConfig = { ...__S3_CONFIG__ }
    return cachedConfig
  }
  cachedConfig = null
  return null
}

export interface SignedRequest {
  url: string
  headers?: SignedHeaders
}

export async function signS3Request(url: string): Promise<SignedRequest> {
  const config = loadConfig()
  if (!config || !isS3Url(url, config)) return { url }
  const headers = await signS3GetRequest(url, config)
  return { url, headers }
}
