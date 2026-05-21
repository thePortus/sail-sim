const app = require('../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Export Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';

  beforeAll(async () => {
    const ownerResponse = await supertest(app).post('/api/user/login')
      .send({
        username: process.env.OWNER_USERNAME || 'jesuit-catalogs-owner',
        password: process.env.OWNER_PASSWORD || 'password'
      });
    ownerToken = ownerResponse.body.token;
    const adminResponse = await supertest(app).post('/api/user/login')
      .send({
        username: 'testAdmin',
        password: 'password'
      });
    adminToken = adminResponse.body.token;
    const editorResponse = await supertest(app).post('/api/user/login')
      .send({
        username: 'testEditor',
        password: 'password'
      });
    editorToken = editorResponse.body.token;
    const userResponse = await supertest(app).post('/api/user/login')
      .send({
        username: 'testUser',
        password: 'password'
      });
    userToken = userResponse.body.token;
  });

  it('GET /api/export should export for owner', async () => {
    const res = await requestWithSupertest.get('/api/export')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('zip'));
  });

  it('GET /api/export should export for admin', async () => {
    const res = await requestWithSupertest.get('/api/export')
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('zip'));
  });

  it('GET /api/export should reject request to export for an editor', async () => {
    const res = await requestWithSupertest.get('/api/export')
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('GET /api/export should reject request to export for a user', async () => {
    const res = await requestWithSupertest.get('/api/export')
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('GET /api/export should reject request to export for an unauthorized person', async () => {
    const res = await requestWithSupertest.get('/api/export');
    expect(res.status).toEqual(401);
  });

});