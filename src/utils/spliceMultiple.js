export default function spliceMultiple (array, indexes) {
  const sorted = [...indexes].sort((a, b) => a - b)

  for (let i = sorted.length - 1; i >= 0; i--) {
    array.splice(sorted[i], 1)
  }

  return array
}