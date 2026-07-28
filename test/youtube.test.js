import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  extractYouTubeVideoId,
  isYouTubeUrl,
} from '../utils/youtube.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

describe('extractYouTubeVideoId', () => {
  test('accepts supported YouTube URL forms', () => {
    const accepted = [
      `https://youtube.com/watch?v=${VIDEO_ID}`,
      `http://www.youtube.com/watch?v=${VIDEO_ID}`,
      `www.youtube.com/watch?v=${VIDEO_ID}`,
      `https://m.youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtu.be/${VIDEO_ID}`,
      `youtu.be/${VIDEO_ID}?si=share-token`,
      `https://youtube.com/embed/${VIDEO_ID}`,
      `https://youtube.com/embed/${VIDEO_ID}?start=30`,
      `https://youtube.com/shorts/${VIDEO_ID}`,
      `https://youtube.com/shorts/${VIDEO_ID}?feature=share`,
      `https://youtube.com/watch?feature=share&v=${VIDEO_ID}&t=30s`,
    ];

    for (const value of accepted) {
      assert.equal(extractYouTubeVideoId(value), VIDEO_ID, value);
      assert.equal(isYouTubeUrl(value), true, value);
    }
  });

  test('rejects malformed, ambiguous, or missing IDs', () => {
    const rejected = [
      '',
      'not a URL',
      'https://youtube.com/watch',
      'https://youtube.com/watch?v=',
      'https://youtube.com/watch?v=dQw4w9WgXc',
      'https://youtube.com/watch?v=dQw4w9WgXcQQ',
      'https://youtube.com/watch?v=dQw4w9WgXc!',
      `https://youtube.com/watch?v=${VIDEO_ID}&v=abcdefghijk`,
      `https://youtube.com/watch?v=${VIDEO_ID}/garbage`,
    ];

    for (const value of rejected) {
      assert.equal(extractYouTubeVideoId(value), null, value);
      assert.equal(isYouTubeUrl(value), false, value);
    }
  });

  test('rejects attacker-controlled subdomains and lookalike hosts', () => {
    const rejected = [
      `https://evil.youtube.com/watch?v=${VIDEO_ID}`,
      `https://www.youtube.com.evil.example/watch?v=${VIDEO_ID}`,
      `https://youtube.com.evil.example/watch?v=${VIDEO_ID}`,
      `https://notyoutube.com/watch?v=${VIDEO_ID}`,
      `https://youtube-nocookie.com/embed/${VIDEO_ID}`,
      `https://youtube.com@evil.example/watch?v=${VIDEO_ID}`,
      `https://attacker@youtube.com/watch?v=${VIDEO_ID}`,
    ];

    for (const value of rejected) {
      assert.equal(extractYouTubeVideoId(value), null, value);
    }
  });

  test('rejects unsafe protocols, ports, markup, and unsupported paths', () => {
    const rejected = [
      `javascript:alert('${VIDEO_ID}')`,
      `data:text/html,${VIDEO_ID}`,
      `ftp://youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtube.com:8443/watch?v=${VIDEO_ID}`,
      `https://youtube.com/watch?v=${VIDEO_ID}<script>alert(1)</script>`,
      `https://youtube.com/watch?v=${VIDEO_ID}&x=%3Cscript%3E`,
      `https://youtube.com/embed/${VIDEO_ID}/garbage`,
      `https://youtube.com/shorts/${VIDEO_ID}/garbage`,
      `https://youtu.be/${VIDEO_ID}/garbage`,
      `https://youtu.be/${VIDEO_ID}/`,
      `https://youtube.com/watch/${VIDEO_ID}`,
      `https://youtube.com/v/${VIDEO_ID}`,
    ];

    for (const value of rejected) {
      assert.equal(extractYouTubeVideoId(value), null, value);
    }
  });
});
