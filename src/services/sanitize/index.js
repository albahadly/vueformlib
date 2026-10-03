import DOMPurify from 'dompurify'

export default function(options, init, enabled) {
  // Run init once so hooks added by it don't pile up on every call
  let purify

  return (input) => {
    if (!enabled || typeof input !== 'string') {
      return input
    }

    if (!purify) {
      purify = typeof init === 'function' ? init(DOMPurify) : DOMPurify
    }

    return purify.sanitize(input, options)
  }
}