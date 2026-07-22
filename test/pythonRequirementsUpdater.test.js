import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildResolvedRequirementsContent,
  formatPythonRequirementsSummary,
  prepareWildcardRequirements
} from '../src/core/pythonRequirementsUpdater.js';

describe('python requirements wildcard updater', () => {
  it('wildcards non-zero majors and skips 0.x by default (byte-identical)', () => {
    const original = [
      '# comment',
      '',
      'requests==2.31.0',
      'httpx==0.23.0',
      'click==7.0',
      'urllib3==2',
      'pkg[crypto]==1.2.3.4',
      'marker==1.2.3; python_version < "3.9"',
      'compatible~=1.4',
      'floor>=2.0',
      'triple===1.2.3',
      'prerelease==1.0.0rc1',
      'epoched==1!2.3.4',
      '-r base.txt',
      '--hash=sha256:abc',
      ''
    ].join('\n');

    const prepared = prepareWildcardRequirements(original);

    // 0.x (httpx) is skipped by default and left byte-identical.
    assert.equal(prepared.skippedZeroMajor, 1);
    assert.equal(prepared.updatablePins.length, 4);
    assert.equal(
      prepared.content,
      [
        '# comment',
        '',
        'requests==2.*',
        'httpx==0.23.0',
        'click==7.*',
        'urllib3==2.*',
        'pkg[crypto]==1.*',
        'marker==1.2.3; python_version < "3.9"',
        'compatible~=1.4',
        'floor>=2.0',
        'triple===1.2.3',
        'prerelease==1.0.0rc1',
        'epoched==1!2.3.4',
        '-r base.txt',
        '--hash=sha256:abc',
        ''
      ].join('\n')
    );
  });

  it('still wildcards 0.x at the major position under the explicit "minor" policy', () => {
    const prepared = prepareWildcardRequirements('httpx==0.23.0\n', {
      zeroMajorPolicy: 'minor'
    });

    assert.equal(prepared.content, 'httpx==0.*\n');
    assert.equal(prepared.updatablePins.length, 1);
    assert.equal(prepared.skippedZeroMajor, 0);
  });

  it('treats 0.x with policy "patch" by keeping major+minor and wildcarding the patch', () => {
    const prepared = prepareWildcardRequirements('httpx==0.23.0\n', {
      zeroMajorPolicy: 'patch'
    });

    assert.equal(prepared.content, 'httpx==0.23.*\n');
    assert.equal(prepared.updatablePins.length, 1);
    assert.equal(prepared.updatablePins[0].wildcardPrefix, '0.23.');
  });

  it('treats 0.x with policy "skip" as byte-identical passthrough and counts it', () => {
    const prepared = prepareWildcardRequirements('httpx==0.23.0\n', {
      zeroMajorPolicy: 'skip'
    });

    assert.equal(prepared.content, 'httpx==0.23.0\n');
    assert.equal(prepared.updatablePins.length, 0);
    assert.equal(prepared.skippedZeroMajor, 1);
  });

  it('projects resolved versions back onto original lines and preserves pass-through lines', () => {
    const original = [
      'requests==2.31.0',
      'httpx==0.23.0',
      'pkg[crypto]==1.2.3',
      'marker==1.2.3; python_version < "3.9"',
      ''
    ].join('\n');
    // Explicit "minor" policy so the 0.x httpx pin participates in the projection.
    const prepared = prepareWildcardRequirements(original, { zeroMajorPolicy: 'minor' });
    const resolved = [
      'httpx==0.28.1',
      'pkg==1.4.0',
      'requests==2.32.5',
      ''
    ].join('\n');

    const final = buildResolvedRequirementsContent(
      original,
      resolved,
      prepared.updatablePins
    );

    assert.equal(
      final.content,
      [
        'requests==2.32.5',
        'httpx==0.28.1',
        'pkg[crypto]==1.4.0',
        'marker==1.2.3; python_version < "3.9"',
        ''
      ].join('\n')
    );
    assert.deepEqual(final.changes, [
      { name: 'requests', from: '2.31.0', to: '2.32.5' },
      { name: 'httpx', from: '0.23.0', to: '0.28.1' },
      { name: 'pkg[crypto]', from: '1.2.3', to: '1.4.0' }
    ]);
  });

  it('preserves CRLF newline style per line on re-pin', () => {
    const original = 'requests==2.31.0\r\nhttpx==0.23.0\n';
    const prepared = prepareWildcardRequirements(original, { zeroMajorPolicy: 'minor' });
    const resolved = 'httpx==0.28.1\nrequests==2.32.5\n';

    const final = buildResolvedRequirementsContent(
      original,
      resolved,
      prepared.updatablePins
    );

    assert.equal(final.content, 'requests==2.32.5\r\nhttpx==0.28.1\n');
  });

  it('prefix guard accepts a resolved version inside the 0.x lane', () => {
    const original = 'httpx==0.23.0\n';
    const prepared = prepareWildcardRequirements(original, { zeroMajorPolicy: 'minor' });

    const final = buildResolvedRequirementsContent(
      original,
      'httpx==0.28.1\n',
      prepared.updatablePins
    );

    assert.equal(final.content, 'httpx==0.28.1\n');
  });

  it('prefix guard rejects a 0.x pin that resolves across the major boundary', () => {
    const original = 'httpx==0.23.0\n';
    const prepared = prepareWildcardRequirements(original, { zeroMajorPolicy: 'minor' });

    assert.throws(
      () =>
        buildResolvedRequirementsContent(
          original,
          'httpx==1.0.0\n',
          prepared.updatablePins
        ),
      /falls outside its wildcard range 0\.\*/
    );
  });

  it('prefix guard rejects a resolved version that crosses the original major', () => {
    const original = 'requests==2.31.0\n';
    const prepared = prepareWildcardRequirements(original);

    assert.throws(
      () =>
        buildResolvedRequirementsContent(
          original,
          'requests==3.0.0\n',
          prepared.updatablePins
        ),
      /falls outside its wildcard range 2\.\*/
    );
  });

  it('passes through non-transformable lines and itemizes the reasons', () => {
    const original = [
      'compatible~=1.4',
      'marker==1.2.3; python_version < "3.9"',
      'prerelease==1.0.0rc1',
      'epoched==1!2.3.4',
      '-r base.txt',
      '--hash=sha256:abc',
      '# a comment',
      ''
    ].join('\n');

    const prepared = prepareWildcardRequirements(original);

    assert.equal(prepared.updatablePins.length, 0);
    assert.equal(prepared.passedThrough, 7);
    assert.deepEqual(prepared.passedThroughByReason, {
      'non-pin-operator': 1,
      'environment-marker': 1,
      'pre-release': 1,
      epoch: 1,
      include: 1,
      hash: 1,
      comment: 1
    });

    const summaryLines = formatPythonRequirementsSummary({
      changes: [],
      transformed: 0,
      skippedZeroMajor: 0,
      passedThrough: prepared.passedThrough,
      passedThroughByReason: prepared.passedThroughByReason,
      zeroMajorPolicy: prepared.zeroMajorPolicy
    });
    const summary = summaryLines.join('\n');

    assert.match(summary, /Passed through: 7/);
    assert.match(summary, /1 pre-release/);
    assert.match(summary, /1 epoch/);
    assert.match(summary, /1 environment-marker/);
  });

  it('summary reports skipped 0.x pins only when policy is skip', () => {
    const skipSummary = formatPythonRequirementsSummary({
      changes: [],
      transformed: 0,
      skippedZeroMajor: 2,
      passedThrough: 0,
      passedThroughByReason: {},
      zeroMajorPolicy: 'skip'
    }).join('\n');
    assert.match(skipSummary, /Skipped 0\.x pins: 2/);

    const minorSummary = formatPythonRequirementsSummary({
      changes: [],
      transformed: 0,
      skippedZeroMajor: 0,
      passedThrough: 0,
      passedThroughByReason: {},
      zeroMajorPolicy: 'minor'
    }).join('\n');
    assert.doesNotMatch(minorSummary, /Skipped 0\.x pins/);
  });
});
