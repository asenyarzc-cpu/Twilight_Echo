const COLLATOR = new Intl.Collator('zh-Hans-CN-u-co-pinyin')

/**
 * Boundary characters for each pinyin initial group under zh-CN collation.
 * A CJK character belongs to group i when it sorts at or after BOUNDARIES[i]
 * but strictly before BOUNDARIES[i + 1]. The initials array omits i/u/v
 * because standard Mandarin has no syllables beginning with those letters.
 */
const BOUNDARIES = [
  '阿',
  '芭',
  '擦',
  '搭',
  '蛾',
  '发',
  '噶',
  '哈',
  '机',
  '喀',
  '垃',
  '妈',
  '拿',
  '哦',
  '啪',
  '七',
  '然',
  '撒',
  '他',
  '挖',
  '吸',
  '压',
  '匝'
] as const

const INITIALS = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'w',
  'x',
  'y',
  'z'
] as const

const cjkCharPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export function isCjkChar(char: string): boolean {
  return char.length === 1 && cjkCharPattern.test(char)
}

export function getPinyinInitial(char: string): string {
  if (!isCjkChar(char)) return ''

  let low = 0
  let high = BOUNDARIES.length - 1

  if (COLLATOR.compare(char, BOUNDARIES[0]) < 0) return INITIALS[0]

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (COLLATOR.compare(char, BOUNDARIES[mid]) >= 0) {
      low = mid
    } else {
      high = mid - 1
    }
  }

  return INITIALS[low]
}

export function getPinyinInitials(text: string): string {
  let result = ''
  for (const char of text) {
    result += getPinyinInitial(char)
  }
  return result
}
