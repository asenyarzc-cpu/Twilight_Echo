import assert from 'node:assert/strict'
import test from 'node:test'

const {
  buildLyricLines,
  findActiveLyricIndex,
  getLyricWordProgress,
  hasLyricContent,
  parseLyricVoiceDraftRows,
  parseLyricVoiceTag,
  parsePlainLyrics,
  parseTimedLrc,
  rewriteLyricVoiceDraftRows,
  serializeLyricVoiceTag,
  stripValidLyricVoiceTags
} = (await import(new URL('./lyrics.ts', import.meta.url).href)) as typeof import('./lyrics')

test('parseTimedLrc parses timestamped LRC lines', () => {
  assert.deepEqual(parseTimedLrc('[00:01.20]First line\n[00:03.50][00:04.00]Repeat'), [
    { time: 1.2, text: 'First line' },
    { time: 3.5, text: 'Repeat' },
    { time: 4, text: 'Repeat' }
  ])
})

test('parsePlainLyrics keeps untimed embedded lyrics visible', () => {
  assert.deepEqual(parsePlainLyrics('[ti:Song]\nFirst plain line\n\nSecond plain line'), [
    'First plain line',
    'Second plain line'
  ])
})

test('buildLyricLines falls back to plain lyrics when no timed lines exist', () => {
  assert.deepEqual(buildLyricLines('First plain line\nSecond plain line', null), [
    { time: null, text: 'First plain line', translation: null, romanization: null, timed: false },
    { time: null, text: 'Second plain line', translation: null, romanization: null, timed: false }
  ])
})

test('findActiveLyricIndex uses timed lyric boundaries', () => {
  const lines = buildLyricLines('[00:01.00]First\n[00:03.00]Second\n[00:03.00]Echo', null)

  assert.equal(findActiveLyricIndex(lines, 0.5), -1)
  assert.equal(findActiveLyricIndex(lines, 1), 0)
  assert.equal(findActiveLyricIndex(lines, 2.5), 0)
  assert.equal(findActiveLyricIndex(lines, 3), 2)
  assert.equal(findActiveLyricIndex(lines, 10), 2)
})

test('findActiveLyricIndex ignores untimed lyrics', () => {
  const lines = buildLyricLines('First plain line\nSecond plain line', null)

  assert.equal(findActiveLyricIndex(lines, 10), -1)
})

test('findActiveLyricIndex handles large lyric files quickly', () => {
  const lines = Array.from({ length: 10000 }, (_, index) => ({
    time: index * 0.75,
    text: `Line ${index}`,
    translation: null,
    romanization: null,
    timed: true
  }))

  const start = performance.now()
  for (let i = 0; i < 10000; i++) {
    assert.equal(findActiveLyricIndex(lines, 5000), 6666)
  }
  const elapsed = performance.now() - start

  assert.ok(elapsed < 80, `active lyric lookup took ${elapsed.toFixed(2)}ms, expected < 80ms`)
})

test('parseTimedLrc keeps Enhanced LRC word timings', async () => {
  const { findActiveWordIndex } = (await import(
    new URL('./lyrics.ts', import.meta.url).href
  )) as typeof import('./lyrics')
  const lines = parseTimedLrc('[00:10.00]<00:10.00>Hel<00:10.40>lo <00:10.80>world')
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.text, 'Hello world')
  assert.deepEqual(
    lines[0]?.words?.map((word) => ({ time: word.time, text: word.text })),
    [
      { time: 10, text: 'Hel' },
      { time: 10.4, text: 'lo ' },
      { time: 10.8, text: 'world' }
    ]
  )
  assert.equal(findActiveWordIndex(lines[0]?.words ?? [], 10.5), 1)
})

test('parseTimedLrc parses NetEase YRC word lyrics', () => {
  const lines = parseTimedLrc('[10000,2000](10000,400,0)Hel(10400,400,0)lo (10800,400,0)world')
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.time, 10)
  assert.equal(lines[0]?.text, 'Hello world')
  assert.equal(lines[0]?.words?.length, 3)
  assert.equal(lines[0]?.words?.[1]?.endTime, 10.8)
})

test('getLyricWordProgress maps timestamped words to a clamped karaoke fill', () => {
  const word = { time: 10, endTime: 10.4, text: 'Hel' }
  assert.equal(getLyricWordProgress(word, 10.5, 9.9), 0)
  assert.ok(Math.abs(getLyricWordProgress(word, 10.5, 10.2) - 0.5) < 1e-9)
  assert.equal(getLyricWordProgress(word, 10.5, 11), 1)
  assert.equal(getLyricWordProgress({ time: 12, endTime: null, text: 'tail' }, null, 12.2), 1)
})

test('parseTimedLrc flattens NetEase lyric/new JSON credit lines into readable text', () => {
  const payload = [
    '{"t":-1,"c":[{"tx":"作词: "},{"tx":"ACO"}]}',
    '{"t":-1,"c":[{"tx":"作曲: "},{"tx":"ACO"}]}',
    '[10000,2000](10000,400,0)バケット(10400,400,0)ソーダ'
  ].join('\n')

  const lines = parseTimedLrc(payload)
  assert.equal(lines[0]?.text, '作词: ACO')
  assert.equal(lines[1]?.text, '作曲: ACO')
  assert.equal(lines[2]?.text, 'バケットソーダ')
  assert.equal(lines[2]?.time, 10)
  assert.ok(!lines.some((line) => line.text.includes('"tx"')))
})

test('parsePlainLyrics flattens NetEase JSON credit lines when lyrics are untimed', () => {
  assert.deepEqual(
    parsePlainLyrics(
      '{"t":-1,"c":[{"tx":"作词: "},{"tx":"ACO"}]}\n{"t":-1,"c":[{"tx":"作曲: "},{"tx":"ACO"}]}'
    ),
    ['作词: ACO', '作曲: ACO']
  )
})

test('buildLyricLines shows NetEase credits without raw JSON when only metadata is present', () => {
  const lines = buildLyricLines(
    '{"t":-1,"c":[{"tx":"作词: "},{"tx":"ACO"}]}\n{"t":-1,"c":[{"tx":"作曲: "},{"tx":"ACO"}]}',
    null
  )
  assert.deepEqual(
    lines.map((line) => line.text),
    ['作词: ACO', '作曲: ACO']
  )
  assert.ok(!lines.some((line) => line.text.includes('{"t"')))
})

test('buildLyricLines pairs YRC word lyrics with drifted tlyric translations', () => {
  // NetEase YRC line timestamps drift ~1s from the companion tlyric, so the
  // exact-millisecond join used to drop every translation for word lyrics.
  const yrc = [
    '[21990,540](21990,540,0)Yeah',
    '[25590,3060](25590,330,0)Who (25920,120,0)am (26040,300,0)I',
    '[28800,3090](28800,210,0)You (29010,660,0)decide'
  ].join('\n')
  const tlyric = ['[00:20.92]yeah', '[00:25.29]我是谁？', '[00:28.42]你来决定'].join('\n')
  const lines = buildLyricLines(yrc, tlyric)
  assert.equal(lines.length, 3)
  assert.equal(lines[0]?.translation, 'yeah')
  assert.equal(lines[1]?.translation, '我是谁？')
  assert.equal(lines[2]?.translation, '你来决定')
  assert.equal(lines[1]?.words?.length, 3)
})

test('buildLyricLines includes the exact 1500ms translation and romanization boundary', () => {
  const lines = buildLyricLines(
    '[10000,1000](10000,500,0)Line one',
    '[00:11.50]边界翻译',
    '[00:08.50]boundary romanization'
  )
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.translation, '边界翻译')
  assert.equal(lines[0]?.romanization, 'boundary romanization')
})

test('buildLyricLines does not pair a translation that is far away', () => {
  const lines = buildLyricLines('[10000,1000](10000,500,0)Line one', '[00:25.29]二十多秒后的翻译')
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.translation, null)
})

test('buildLyricLines keeps exact matches and only uses each layer line once', () => {
  const original = ['[00:10.00]<00:10.00>Hel<00:10.40>lo', '[00:12.00]Second'].join('\n')
  const translation = ['[00:10.02]你好', '[00:12.00]第二句'].join('\n')
  const lines = buildLyricLines(original, translation)
  // First line has no exact ms match; nearest is 10.02 within tolerance.
  assert.equal(lines[0]?.translation, '你好')
  // Second line is exact and must not steal/be stolen by the tolerant pass.
  assert.equal(lines[1]?.translation, '第二句')
})

test('explicit voice tags group only named groups and preserve compatibility text', () => {
  const lyrics = [
    '[00:10.00][te:voice role=lead lane=start speaker=Alice group=duet-1]First',
    '[00:10.00][te:voice lane=end role=lead speaker=Bob group=duet-1]Second',
    '[00:10.40][te:voice role=harmony lane=end speaker=Bob group=duet-1]Harmony',
    '[00:12.00][te:voice role=lead lane=start]Not grouped',
    '[00:12.00][te:voice role=lead lane=end]Still separate'
  ].join('\n')
  const lines = buildLyricLines(lyrics, '[00:10.00]组合翻译')

  assert.equal(lines.length, 3, 'only the explicit group is merged')
  assert.equal(lines[0].rowKey, 'group:duet-1')
  assert.equal(lines[0].text, 'First · Second')
  assert.equal(lines[0].translation, '组合翻译')
  assert.equal(lines[0].voices?.length, 3)
  assert.deepEqual(
    lines[0].voices?.map((voice) => [voice.role, voice.lane, voice.speaker, voice.time]),
    [
      ['lead', 'start', 'Alice', 10],
      ['lead', 'end', 'Bob', 10],
      ['harmony', 'end', 'Bob', 10.4]
    ]
  )
  assert.notEqual(lines[1].rowKey, lines[2].rowKey)
})

test('voice tags work with Enhanced LRC and YRC word timing', () => {
  const enhanced = buildLyricLines(
    '[00:10.00][te:voice role=lead lane=start group=words]<00:10.00>Hel<00:10.40>lo',
    null
  )
  assert.equal(enhanced[0].voices?.[0].words?.length, 2)

  const yrc = buildLyricLines(
    '[10000,1200][te:voice role=background lane=end group=words](10000,600,0)Back(10600,600,0)ground',
    null
  )
  assert.equal(yrc[0].voices?.[0].role, 'background')
  assert.equal(yrc[0].voices?.[0].text, 'Background')
})

test('voice tags are strict and malformed or unknown tags stay visible', () => {
  assert.deepEqual(parseLyricVoiceTag('[te:voice role=lead lane=start]'), {
    role: 'lead',
    lane: 'start'
  })
  assert.equal(parseLyricVoiceTag('[te:voice lane=start]'), null)
  assert.equal(parseLyricVoiceTag('[te:voice role=lead lane=left]'), null)
  assert.equal(parseLyricVoiceTag('[te:voice role=lead role=harmony lane=end]'), null)
  assert.equal(parseLyricVoiceTag('[te:voice role=lead lane=end extra=x]'), null)

  const duplicate = buildLyricLines(
    '[00:01.00][te:voice role=lead lane=start][te:voice role=lead lane=end]Keep both markers',
    null
  )
  assert.equal(duplicate[0].voices, undefined)
  assert.match(duplicate[0].text, /\[te:voice role=lead lane=start\]/)

  const lines = buildLyricLines('[00:01.00][te:voice role=lead lane=left]Keep marker', null)
  assert.equal(lines[0].text, '[te:voice role=lead lane=left]Keep marker')
  assert.equal(lines[0].voices, undefined)
})

test('voice tag serialization percent-encodes speaker identity and draft rewrites round trip', () => {
  const tag = serializeLyricVoiceTag({
    role: 'harmony',
    lane: 'end',
    speaker: '歌手 A',
    group: '副歌 1'
  })
  assert.equal(
    tag,
    '[te:voice role=harmony lane=end speaker=%E6%AD%8C%E6%89%8B%20A group=%E5%89%AF%E6%AD%8C%201]'
  )
  assert.deepEqual(parseLyricVoiceTag(tag), {
    role: 'harmony',
    lane: 'end',
    speaker: '歌手 A',
    group: '副歌 1'
  })

  const punctuationTag = serializeLyricVoiceTag({
    role: 'lead',
    lane: 'start',
    speaker: "O'Connor (live)!*",
    group: 'chorus (2)!'
  })
  assert.match(punctuationTag, /speaker=O%27Connor%20%28live%29%21%2A/)
  assert.deepEqual(parseLyricVoiceTag(punctuationTag), {
    role: 'lead',
    lane: 'start',
    speaker: "O'Connor (live)!*",
    group: 'chorus (2)!'
  })

  const source = '[00:01.00]<00:01.00>Hello [te:unknown value=x]\nplain'
  const rewritten = rewriteLyricVoiceDraftRows(source, [
    { sourceIndex: 0, metadata: { role: 'lead', lane: 'start', speaker: 'Alice' } }
  ])
  assert.equal(
    rewritten,
    '[00:01.00][te:voice role=lead lane=start speaker=Alice]<00:01.00>Hello [te:unknown value=x]\nplain'
  )
  assert.equal(parseLyricVoiceDraftRows(rewritten)[0].metadata?.speaker, 'Alice')
  assert.equal(
    rewriteLyricVoiceDraftRows(rewritten, [{ sourceIndex: 0, metadata: null }]),
    source
  )
})

test('desktop compatibility projection strips valid tags and preserves malformed tags', () => {
  const source = [
    '[00:01.00][te:voice role=lead lane=start]Lead',
    '[00:02.00][te:voice role=lead lane=left]Malformed'
  ].join('\n')
  assert.equal(
    stripValidLyricVoiceTags(source),
    '[00:01.00]Lead\n[00:02.00][te:voice role=lead lane=left]Malformed'
  )
  assert.equal(stripValidLyricVoiceTags(null), null)
})

test('unmarked lyrics never infer speakers from colons, parentheses or matching timestamps', () => {
  const lines = buildLyricLines(
    '[00:01.00]Alice: First\n[00:01.00](Bob) Second\n[00:02.00]Together',
    null
  )
  assert.equal(lines.length, 3)
  assert.ok(lines.every((line) => line.voices === undefined))
})

test('plain lyrics retain explicit voice metadata without making them timed', () => {
  const lines = buildLyricLines(
    '[te:voice role=lead lane=start speaker=Alice]Untimed duet line\nOrdinary line',
    null
  )
  assert.equal(lines[0].timed, false)
  assert.equal(lines[0].voices?.[0].speaker, 'Alice')
  assert.equal(lines[0].voices?.[0].lane, 'start')
  assert.equal(lines[1].voices, undefined)
})

test('hasLyricContent accepts only non-empty trimmed strings', () => {
  assert.equal(hasLyricContent('lyrics'), true)
  assert.equal(hasLyricContent('  lyrics  '), true)
  assert.equal(hasLyricContent(''), false)
  assert.equal(hasLyricContent('   '), false)
  assert.equal(hasLyricContent(null), false)
  assert.equal(hasLyricContent(undefined), false)
})

test('buildLyricLines folds interleaved bilingual LRC lines into original + translation', () => {
  // Real-world shape from a NetEase-style merged LRC: the translation sits on
  // its own row directly below the original at the SAME timestamp. It must be
  // attached as `translation` (so the smaller translation style applies) rather
  // than rendering as a second full-size row.
  const lyrics = [
    '[00:00.41]Don\'t Call (feat. Free Nationals) (Explicit) - 蔡徐坤',
    '[00:02.07]词曲：蔡徐坤 KUN/Andrew Neely/Ariana Wong/Dan Farber',
    '[00:11.23]House of cards',
    '[00:11.23]纸牌屋',
    '[00:16.07]Coming down',
    '[00:16.07]正一寸寸倾塌',
    '[01:57.63]But',
    '[01:57.63]然……',
    '[01:58.45]Don\'t call my phone',
    '[01:58.45]勿扰，别再拨通这号码',
    '[02:07.96]Don\'t call my phone',
    '[02:07.96]勿扰，别再拨通这号码'
  ].join('\n')

  const lines = buildLyricLines(lyrics, null)

  const withTranslation = lines.filter((line) => line.translation != null)
  assert.equal(withTranslation.length, 5, 'expected the five bilingual pairs to carry translations')

  const house = lines.find((line) => line.text === 'House of cards')
  assert.equal(house?.translation, '纸牌屋')
  const comingDown = lines.find((line) => line.text === 'Coming down')
  assert.equal(comingDown?.translation, '正一寸寸倾塌')
  const but = lines.find((line) => line.text === 'But')
  assert.equal(but?.translation, '然……')

  // Credit / title lines stay ordinary rows and must not absorb a neighbor.
  const credit = lines.find((line) => line.text.startsWith('词曲'))
  assert.equal(credit?.translation, null)
  const title = lines.find((line) => line.text.includes('Explicit'))
  assert.equal(title?.translation, null)
  // The folded rows collapse the pair: no separate full-size CJK row remains.
  assert.equal(lines.some((line) => line.text === '纸牌屋'), false)
  assert.equal(lines.some((line) => line.text === '正一寸寸倾塌'), false)
})

test('buildLyricLines does not fold same-script or voice-tagged lines', () => {
  const echo = buildLyricLines('[00:01.00]Hello\n[00:01.00]Hello again', null)
  assert.equal(echo.length, 2)
  assert.ok(echo.every((line) => line.translation === null))

  const bothCjk = buildLyricLines('[00:01.00]我爱你\n[00:01.00]我恨你', null)
  assert.equal(bothCjk.length, 2)
  assert.ok(bothCjk.every((line) => line.translation === null))

  const voiced = buildLyricLines(
    '[00:01.00][te:voice role=lead lane=start]Hello\n' +
      '[00:01.00][te:voice role=lead lane=end]你好',
    null
  )
  assert.equal(voiced.length, 2)
  assert.ok(voiced.every((line) => line.translation === null))
})

test('explicit translation payload takes precedence over interleaved folding', () => {
  const lines = buildLyricLines('[00:11.23]House of cards\n[00:11.23]纸牌屋', '[00:11.23]官方翻译')
  const row = lines.find((line) => line.text === 'House of cards')
  assert.equal(row?.translation, '官方翻译')
})
