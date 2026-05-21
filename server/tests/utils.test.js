const request = require('supertest');
const app = require('../app');

const validateRequest = require('../utils/validate-request');

describe('Utilities', () => {
  describe('checkFieldsExist', () => {
    it('should detect if a required field is missing', async () => {
      const mockReqObject = {
        body: {},
      };
      const response = validateRequest.checkFieldsExist(
        mockReqObject,
        [],
        ['sampleField']
      );
      expect(response.length).toBeGreaterThanOrEqual(1);
      expect(response[0]).toBe('Must contain a \'sampleField\' field!');
    });

    it('should detect if multiple required fields are missing', async () => {
      const mockReqObject = {
        body: {},
      };
      const response = validateRequest.checkFieldsExist(
        mockReqObject,
        [],
        ['sampleField', 'anotherField']
      );
      expect(response.length).toBeGreaterThanOrEqual(2);
      expect(response[0]).toBe('Must contain a \'sampleField\' field!');
      expect(response[1]).toBe('Must contain a \'anotherField\' field!');
    });

    it('should detect if all required fields are present', async () => {
      const mockReqObject = {
        body: {
          sampleField: 'sampleValue',
          anotherField: 'anotherValue',
        },
      };
      const response = validateRequest.checkFieldsExist(
        mockReqObject,
        [],
        ['sampleField', 'anotherField']
      );
      expect(response.length).toBe(0);
    });
  });

  describe('checkFieldTypes', () => {

    it('should return no errors if an integer is submitted when integer is required', async () => {
      const mockReqObject = {
        body: {
          sampleField: 123,
        },
      };
      const response = validateRequest.checkFieldTypes(
        mockReqObject,
        [],
        [{ field: 'sampleField', type: 'integer' }]
      );
  
      expect(response.length).toBe(0);
    });

    it('should return an error if a non-integer is submitted when integer is required', async () => {
      const mockReqObject = {
        body: {
          sampleField: 123.45,
        },
      };
      const response = validateRequest.checkFieldTypes(
        mockReqObject,
        [],
        [{ field: 'sampleField', type: 'integer' }]
      );

      expect(response.length).toBeGreaterThanOrEqual(1);
      expect(response[0]).toBe('\'sampleField\' must be of type \'integer\'!');
    });
  });
});
