const request = require('supertest');
const app = require('../app');

describe('Authentication Middleware', () => {
  describe('verifyToken', () => {
    it('should return 401 Unauthorized if no authorization header is provided', async () => {
      const response = await request(app)
        .get('/api/user');

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Unauthorized');
    });

  });

  describe('verifyEditorToken', () => {
    it('should return 401 Unauthorized if no authorization header is provided', async () => {
      const response = await request(app)
        .get('/api/user');

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Unauthorized');
    });

  });

  describe('verifyAdminToken', () => {
    it('should return 401 Unauthorized if no authorization header is provided', async () => {
      const response = await request(app)
        .get('/api/user');

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Unauthorized');
    });

  });

  describe('verifyOwnerToken', () => {
    it('should return 401 Unauthorized if no authorization header is provided', async () => {
      const response = await request(app)
        .get('/api/user');

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Unauthorized');
    });

  });
});