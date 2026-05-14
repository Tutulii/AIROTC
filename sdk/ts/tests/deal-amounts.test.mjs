import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTokenAmountToRawUnits,
  rawTokenBalanceCoversAmount,
} from '../dist/index.js';

test('parseTokenAmountToRawUnits converts token amounts without floating point math', () => {
  assert.equal(parseTokenAmountToRawUnits(500, 6), 500000000n);
  assert.equal(parseTokenAmountToRawUnits('1.234567', 6), 1234567n);
  assert.equal(parseTokenAmountToRawUnits('0.000001', 6), 1n);
  assert.equal(parseTokenAmountToRawUnits('1.2300000', 6), 1230000n);
  assert.equal(parseTokenAmountToRawUnits('.5', 6), 500000n);
  assert.equal(parseTokenAmountToRawUnits('1.0', 0), 1n);
});

test('parseTokenAmountToRawUnits rejects amounts that would require rounding', () => {
  assert.throws(
    () => parseTokenAmountToRawUnits('0.0000005', 6),
    /too many decimal places/
  );
  assert.throws(
    () => parseTokenAmountToRawUnits('1.2345671', 6),
    /too many decimal places/
  );
});

test('parseTokenAmountToRawUnits validates amount and decimal inputs', () => {
  assert.throws(() => parseTokenAmountToRawUnits(0, 6), /greater than zero/);
  assert.throws(() => parseTokenAmountToRawUnits(Number.NaN, 6), /finite/);
  assert.throws(() => parseTokenAmountToRawUnits(Number.POSITIVE_INFINITY, 6), /finite/);
  assert.throws(() => parseTokenAmountToRawUnits(Number.MAX_SAFE_INTEGER + 1, 6), /decimal string/);
  assert.throws(() => parseTokenAmountToRawUnits('', 6), /must not be empty/);
  assert.throws(() => parseTokenAmountToRawUnits('1e3', 6), /base-10 decimal/);
  assert.throws(() => parseTokenAmountToRawUnits('1,000', 6), /base-10 decimal/);
  assert.throws(() => parseTokenAmountToRawUnits('1', -1), /between 0 and 255/);
  assert.throws(() => parseTokenAmountToRawUnits('1', 1.5), /integer/);
  assert.throws(() => parseTokenAmountToRawUnits('1', 256), /between 0 and 255/);
  assert.throws(() => parseTokenAmountToRawUnits('18446744073709551616', 0), /u64 maximum/);
});

test('rawTokenBalanceCoversAmount compares raw balances as bigint values', () => {
  assert.equal(
    rawTokenBalanceCoversAmount('9007199254740992', 9007199254740993n),
    false
  );
  assert.equal(
    rawTokenBalanceCoversAmount('9007199254740993', 9007199254740993n),
    true
  );
  assert.throws(
    () => rawTokenBalanceCoversAmount('1.5', 1n),
    /unsigned integer string/
  );
});
