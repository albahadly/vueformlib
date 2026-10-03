import spliceMultiple from './../../src/utils/spliceMultiple'
import normalize from './../../src/utils/normalize'

describe('spliceMultiple', () => {
  it('should remove multi-digit indexes correctly', () => {
    const array = [...Array(12).keys()]

    expect(spliceMultiple(array, [2, 10])).toStrictEqual([0, 1, 3, 4, 5, 6, 7, 8, 9, 11])
  })

  it('should not mutate the indexes array', () => {
    const indexes = [10, 2]

    spliceMultiple([...Array(12).keys()], indexes)

    expect(indexes).toStrictEqual([10, 2])
  })
})

describe('normalize', () => {
  it('should normalize integers and floats including negatives', () => {
    expect(normalize('5')).toBe(5)
    expect(normalize('-5')).toBe(-5)
    expect(normalize('1.5')).toBe(1.5)
    expect(normalize('-1.5')).toBe(-1.5)
  })

  it('should not turn invalid numbers into NaN', () => {
    expect(normalize('--5')).toBe('--5')
  })
})
