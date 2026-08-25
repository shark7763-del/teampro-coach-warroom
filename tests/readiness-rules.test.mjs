import assert from 'node:assert/strict';
import { evaluateReadiness } from '../app-modules/readiness-rules.js';

function level(input) {
  return evaluateReadiness({ recordId: 'r_test', ...input }).level;
}

assert.equal(level({ painScore: 8, fatigue: 2, motivation: 5, expectedCompletion: 100 }), 'red', 'high pain forces red');
assert.equal(level({ painScore: 5, painImpact: '影響動作', fatigue: 2, motivation: 5, expectedCompletion: 100 }), 'red', 'pain with movement impact forces red');
assert.equal(level({ painScore: 0, fatigue: 9, motivation: 5, expectedCompletion: 100 }), 'yellow', 'high fatigue forces at least yellow');
assert.equal(level({ painScore: 0, fatigue: 2, motivation: 1, expectedCompletion: 100 }), 'yellow', 'low motivation forces at least yellow');
assert.equal(level({ painScore: 0, fatigue: 2, motivation: 5, expectedCompletion: 30 }), 'red', 'low completion forces red');
assert.equal(level({ painScore: 0, fatigue: 2, motivation: 5, expectedCompletion: 100 }), 'green', 'normal report is green');
assert.equal(evaluateReadiness({ name: 'Demo 選手X' }).level, 'gray', 'missing report is gray');
assert.equal(level({ painScore: '', fatigue: '', motivation: '', expectedCompletion: 100 }), 'gray', 'missing critical fields is gray');
assert.equal(level({ painScore: 0, fatigue: 2, motivation: 5, expectedCompletion: 100, declining: true }), 'yellow', 'declining trend forces at least yellow');
assert.equal(level({ painScore: 0, fatigue: 2, motivation: 5, expectedCompletion: 51 }), 'green', 'completion boundary 51 remains green when otherwise stable');
assert.equal(level({ painScore: 0, fatigue: 2, motivation: 5, expectedCompletion: 50 }), 'yellow', 'completion boundary 50 forces yellow');
assert.equal(level({ painScore: 'bad', fatigue: 'bad', motivation: 'bad', expectedCompletion: 100 }), 'gray', 'invalid critical values are treated as missing');

console.log('readiness-rules: all assertions passed');
