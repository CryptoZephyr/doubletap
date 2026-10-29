import { describe, expect, test } from 'vitest';
import { parseProveArgs, templateValue, templateWhere } from '../src/cli.js';

describe('prove CLI arguments and templates', () => {
  test('parses the prove command and defaults', () => {
    const options = parseProveArgs([
      'prove',
      '--function', 'pay-naive',
      '--body', '{"orderId":"$RUN","requestId":"$REQ"}',
      '--table', 'charges',
      '--where', 'orderId=$RUN',
    ]);

    expect(options).toMatchObject({
      functionId: 'pay-naive',
      count: 100,
      table: 'charges',
      whereField: 'orderId',
      whereValue: '$RUN',
      database: 'doubletap',
      expect: 1,
    });
  });

  test('enforces the execution cap and validates the where expression', () => {
    const args = [
      'prove',
      '--function', 'pay-naive',
      '--count', '501',
      '--body', '{}',
      '--table', 'charges',
      '--where', 'orderId=$RUN',
    ];
    expect(() => parseProveArgs(args)).toThrow('--count must be between 1 and 500');
    expect(() => parseProveArgs([
      'prove',
      '--function', 'pay-naive',
      '--body', '{}',
      '--table', 'charges',
      '--where', '=',
    ])).toThrow('--where must use field=value syntax');
  });

  test('templates run IDs and request IDs recursively', () => {
    const body = {
      orderId: '$RUN',
      run: '$RUN',
      requestId: '$REQ',
      nested: ['$RUN/$REQ'],
    };

    expect(templateValue(body, 'r_abc', 'q_xyz')).toEqual({
      orderId: 'r_abc',
      run: 'r_abc',
      requestId: 'q_xyz',
      nested: ['r_abc/q_xyz'],
    });
    expect(templateWhere('orderId', '$RUN', 'r_abc')).toEqual({
      field: 'orderId',
      value: 'r_abc',
    });
  });
});
