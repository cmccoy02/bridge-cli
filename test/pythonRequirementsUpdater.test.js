import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildResolvedRequirementsContent,
  prepareWildcardRequirements
} from '../src/core/pythonRequirementsUpdater.js';

describe('python requirements wildcard updater', () => {
  it('wildcards only clean exact pins with major >= 1', () => {
    const original = [
      '# comment',
      '',
      'requests==2.31.0',
      'zero==0.9.1 # keep this exact',
      'pkg[crypto]==1.2.3',
      'marker==1.2.3; python_version < "3.9"',
      'compatible~=1.4',
      'floor>=2.0',
      'triple===1.2.3',
      '-r base.txt',
      '--hash=sha256:abc',
      ''
    ].join('\n');

    const prepared = prepareWildcardRequirements(original);

    assert.equal(prepared.skippedZeroMajor, 1);
    assert.equal(prepared.updatablePins.length, 2);
    assert.equal(
      prepared.content,
      [
        '# comment',
        '',
        'requests==2.*',
        'zero==0.9.1 # keep this exact',
        'pkg[crypto]==1.*',
        'marker==1.2.3; python_version < "3.9"',
        'compatible~=1.4',
        'floor>=2.0',
        'triple===1.2.3',
        '-r base.txt',
        '--hash=sha256:abc',
        ''
      ].join('\n')
    );
  });

  it('projects resolved versions back onto original lines and preserves pass-through lines', () => {
    const original = [
      'requests==2.31.0',
      'zero==0.9.1 # keep this exact',
      'pkg[crypto]==1.2.3',
      'marker==1.2.3; python_version < "3.9"',
      ''
    ].join('\n');
    const prepared = prepareWildcardRequirements(original);
    const resolved = [
      'pkg==1.4.0',
      'requests==2.32.5',
      'zero==0.9.9',
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
        'zero==0.9.1 # keep this exact',
        'pkg[crypto]==1.4.0',
        'marker==1.2.3; python_version < "3.9"',
        ''
      ].join('\n')
    );
    assert.deepEqual(final.changes, [
      { name: 'requests', from: '2.31.0', to: '2.32.5' },
      { name: 'pkg[crypto]', from: '1.2.3', to: '1.4.0' }
    ]);
  });

  it('rejects a resolved version that crosses the original major', () => {
    const original = 'requests==2.31.0\n';
    const prepared = prepareWildcardRequirements(original);

    assert.throws(
      () =>
        buildResolvedRequirementsContent(
          original,
          'requests==3.0.0\n',
          prepared.updatablePins
        ),
      /crosses major/
    );
  });
});
