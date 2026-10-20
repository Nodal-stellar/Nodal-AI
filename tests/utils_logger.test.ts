/**
 * tests/utils_logger.test.ts
 * Unit tests for component-scoped logger utilities in backend/utils/logger.ts.
 */

import { describe, it, expect } from 'vitest';
import { createLogger, generateCorrelationId, REDACT_PATHS } from '../backend/utils/logger';

describe('backend/utils/logger.ts', () => {
  describe('generateCorrelationId', () => {
    it('generates a valid UUID string', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();

      expect(typeof id1).toBe('string');
      expect(typeof id2).toBe('string');
      expect(id1).not.toBe(id2);
      // Verify UUID v4 regex format: 8-4-4-4-12
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(id1).toMatch(uuidRegex);
      expect(id2).toMatch(uuidRegex);
    });
  });

  describe('createLogger', () => {
    it('creates child logger with component binding', () => {
      const child = createLogger('test-service');
      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
      expect(typeof child.warn).toBe('function');
      expect(typeof child.error).toBe('function');
      expect(typeof child.debug).toBe('function');
      expect(child.bindings().component).toBe('test-service');
    });

    it('creates child logger with correlationId when provided', () => {
      const correlationId = 'test-corr-12345';
      const child = createLogger('auth-service', correlationId);
      expect(child.bindings().component).toBe('auth-service');
      expect(child.bindings().correlationId).toBe(correlationId);
    });
  });

  describe('REDACT_PATHS', () => {
    it('includes memo redaction paths', () => {
      expect(REDACT_PATHS).toContain('*.memo');
      expect(REDACT_PATHS).toContain('payload.memo');
      expect(REDACT_PATHS).toContain('data.memo');
    });

    it('includes secret and credential redaction paths', () => {
      expect(REDACT_PATHS).toContain('*.secretKey');
      expect(REDACT_PATHS).toContain('*.privateKey');
      expect(REDACT_PATHS).toContain('*.apiKey');
      expect(REDACT_PATHS).toContain('*.authorization');
      expect(REDACT_PATHS).toContain('*.password');
    });
  });
});
