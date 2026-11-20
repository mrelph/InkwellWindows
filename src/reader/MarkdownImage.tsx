import { useState } from 'react'
import { assetUrl, resolveImageSource } from './assetPaths'

/* Local images load through the privileged asset scheme; everything else
   (remote, network shares, data:, javascript:, unresolvable, or a load
   failure) becomes a quiet placeholder showing the alt text. Spans only: an
   image sits inside a paragraph.

   A failure is remembered for the exact (url, retryKey) that failed, so it
   never sticks: a new `src` (or note) is a new url and tries again, and a
   change of `retryKey` — App passes the library's folder set — retries once,
   so an image refused a moment before its folder was added loads now. */

/** The identity of one load attempt: a failure counts only for this exact
    url under this exact retry key. */
export const attemptKey = (url: string, retryKey: string) => JSON.stringify([url, retryKey])

const reasonFor = (kind: string) =>
  kind === 'remote' ? 'Remote images are not loaded'
    : kind === 'network' ? 'Images on network shares outside your library are not loaded'
      : kind === 'blocked' ? 'Image source not allowed'
        : 'Image could not be loaded'

export function MarkdownImage({ src, alt, title, notePath, retryKey = '' }: {
  src?: string
  alt?: string
  title?: string
  notePath?: string
  retryKey?: string
}) {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const source = resolveImageSource(src, notePath)
  const label = alt?.trim() || 'Image'
  const url = source.kind === 'local' ? assetUrl(source.path, notePath) : ''
  const attempt = attemptKey(url, retryKey)
  const failed = failedFor === attempt

  if (source.kind !== 'local' || failed) {
    return (
      <span className="image-placeholder" role="img" aria-label={label} title={reasonFor(failed ? 'failed' : source.kind)}>
        <span className="image-placeholder-label">{label}</span>
      </span>
    )
  }

  return (
    <img
      key={url}
      className="markdown-image"
      src={url}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      decoding="async"
      onError={() => setFailedFor(attempt)}
    />
  )
}
