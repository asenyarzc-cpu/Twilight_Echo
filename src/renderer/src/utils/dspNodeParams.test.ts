import assert from 'node:assert/strict'
import test from 'node:test'
import type { DspGraphNode } from '../../../shared/dspGraph.ts'
import {
  applyMatrixPreset,
  channelStripRows,
  convolverRoutingMatrix,
  convolverRoutingMode,
  identityMatrix,
  layoutForNode,
  matrixForNode,
  matrixValue,
  normalizeNodeEditorParams,
  resetConvolverRouting,
  setConvolverRoutingMode,
  setMatrixValue,
  setNodeLayout
} from './dspNodeParams.ts'

function node(type: DspGraphNode['type'], params: Record<string, unknown> = {}): DspGraphNode {
  return { id: 'node', type, enabled: true, params }
}

test('matrixForNode normalizes missing and malformed matrices to identity', () => {
  const matrixNode = node('channelMatrix', { layout: '5.1' })
  const matrix = matrixForNode(matrixNode)
  assert.equal(matrix.length, 36)
  assert.deepEqual(matrix, identityMatrix(6))
  assert.equal(matrixValue(matrixNode, 3, 3), 1)

  const malformed = node('channelMatrix', { layout: 'stereo', matrix: [1, 0] })
  assert.deepEqual(matrixForNode(malformed), identityMatrix(2))
  assert.equal((malformed.params.matrix as number[]).length, 4)
})

test('applyMatrixPreset applies a valid preset and resets the select value', () => {
  const matrixNode = node('channelMatrix', { layout: 'stereo', matrix: [] })
  const select = { value: 'stereoToMono' }
  applyMatrixPreset(matrixNode, { target: select } as unknown as Event)
  assert.deepEqual(matrixNode.params.matrix, [0.5, 0.5, 0.5, 0.5])
  assert.equal(select.value, '')
})

test('channelStripRows normalizes rows to the active layout', () => {
  const strip = node('channelStrip', { channels: [{ gainDb: 1 }] })
  assert.equal(channelStripRows(strip).length, 2)
  assert.equal((strip.params.channels as unknown[]).length, 2)
  setNodeLayout(strip, '7.1')
  assert.equal(channelStripRows(strip).length, 8)
  assert.equal(layoutForNode(strip), '7.1')
})

test('convolver routing matrices match mode and normalize when missing', () => {
  const convolver = node('convolver', { layout: 'stereo' })
  assert.equal(convolverRoutingMode(convolver), 'diagonal')
  assert.deepEqual(convolverRoutingMatrix(convolver), [])
  setConvolverRoutingMode(convolver, 'monoToMany')
  assert.deepEqual(convolverRoutingMatrix(convolver), [1, 1])
  setConvolverRoutingMode(convolver, 'matrix')
  assert.deepEqual(convolverRoutingMatrix(convolver), identityMatrix(2))
  resetConvolverRouting(convolver)
  assert.deepEqual(convolverRoutingMatrix(convolver), identityMatrix(2))
  setConvolverRoutingMode(convolver, 'diagonal')
  assert.deepEqual(convolverRoutingMatrix(convolver), [])
})

test('matrix edits clamp to the DSP contract and normalizeNodeEditorParams preserves shape', () => {
  const matrixNode = node('channelMatrix', { layout: 'stereo', matrix: [0, 0, 0, 0] })
  setMatrixValue(matrixNode, 0, 1, 99)
  assert.equal(matrixValue(matrixNode, 0, 1), 4)
  normalizeNodeEditorParams(matrixNode)
  assert.equal((matrixNode.params.matrix as number[]).length, 4)
})
