import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canReadDelivery, canRegisterArrival, isAssignedDriver, validLocation } from '../src/services/delivery-access.ts'

const delivery = { customer_id: 'buyer', store_id: 'store', driver_id: 'driver' }

test('solo los participantes pueden consultar la entrega', () => {
  assert.equal(canReadDelivery({ role: 'B2C', id: 'buyer' }, delivery), true)
  assert.equal(canReadDelivery({ role: 'B2C', id: 'other' }, delivery), false)
  assert.equal(canReadDelivery({ role: 'B2B', id: 'merchant', storeId: 'store' }, delivery), true)
  assert.equal(canReadDelivery({ role: 'B2B', id: 'merchant', storeId: 'other' }, delivery), false)
})

test('la asignación exige coincidir en conductor y tienda', () => {
  assert.equal(isAssignedDriver({ role: 'DRIVER', id: 'driver', storeId: 'store' }, delivery), true)
  assert.equal(isAssignedDriver({ role: 'DRIVER', id: 'other', storeId: 'store' }, delivery), false)
  assert.equal(isAssignedDriver({ role: 'DRIVER', id: 'driver', storeId: 'other' }, delivery), false)
  assert.equal(isAssignedDriver({ role: 'DRIVER', id: 'driver' }, delivery), false)
})

test('rechaza coordenadas inválidas sin coerción', () => {
  assert.equal(validLocation(-16.5, -68.15), true)
  assert.equal(validLocation(0, 0), true)
  for (const position of [[91, 0], [0, 181], ['0', 0], [0, null], [Infinity, 0], [0, NaN]]) {
    assert.equal(validLocation(...position), false)
  }
})

test('solo en tránsito se puede registrar llegada', () => {
  assert.equal(canRegisterArrival('IN_TRANSIT'), true)
  for (const status of ['PENDING', 'ASSIGNED', 'DELIVERED', 'CONFIRMED', 'DISPUTED']) {
    assert.equal(canRegisterArrival(status), false)
  }
})
