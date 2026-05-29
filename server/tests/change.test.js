const app = require('../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Change Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';

  beforeAll(async () => {
    const ownerResponse = await supertest(app).post('/api/user/login')
      .send({
        username: process.env.OWNER_USERNAME || 'sail-sim-owner',
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

    // Create an item in the database to ensure there is at least one change to retrieve
    await requestWithSupertest.post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Jesuit',
      });
  });

  it('GET /api/changes should show all changes for owner', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/changes should show all changes for admin', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5')
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/changes should reject request to show all changes for an editor', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5')
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('GET /api/changes should reject request to show all changes for a user', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5')
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('GET /api/changes should reject request to show all changes for an unauthorized person', async () => {
    const res = await requestWithSupertest.get('/api/changes');
    expect(res.status).toEqual(401);
  });

  it('GET /api/changes/:id should show change for owner', async () => {
    const res = await requestWithSupertest.get('/api/changes/1')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
  });

  it('GET /api/changes/:id should show change for admin', async () => {
    const res = await requestWithSupertest.get('/api/changes/1')
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
  });

  it('GET /api/changes/:id should reject request to show change for an editor', async () => {
    const res = await requestWithSupertest.get('/api/changes/1')
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('GET /api/changes/:id should reject request to show change for a user', async () => {
    const res = await requestWithSupertest.get('/api/changes/1')
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('GET /api/changes/:id should reject request to show change for an unauthorized person', async () => {
    const res = await requestWithSupertest.get('/api/changes/1');
    expect(res.status).toEqual(401);
  });

  it('GET /api/changes?page=1&size=5&table=xyz should filter by table', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5&table=xyz')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/changes?page=1&size=5&table=xyz should search by table', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5&table=FirstCatalogs')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/changes?page=1&size=5&itemId=xyz should filter by itemId', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5&itemId=xyz')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/changes?page=1&size=5&itemId=xyz should search by itemId', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Jesuit',
      });
    const res = await requestWithSupertest.get(`/api/changes?page=0&size=5&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/changes?page=1&size=5&username=xyz should filter by username', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5&username=zxyyxzzxyq')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/changes?page=1&size=5&username=xyz should search by username', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5&username=sail-sim-owner')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/changes?page=1&size=5&action=xyz should filter by action', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5&action=1')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/changes?page=1&size=5&action=xyz should search by action', async () => {
    const res = await requestWithSupertest.get('/api/changes?page=0&size=5&action=Create')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/changes/:id should return a single changes in full detail', async () => {
    const res = await requestWithSupertest.get('/api/changes/1')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('table');
    expect(res.body).toHaveProperty('itemId');
    expect(res.body).toHaveProperty('username');
    expect(res.body).toHaveProperty('action');
    expect(res.body).toHaveProperty('oldState');
    expect(res.body).toHaveProperty('changes');
  });

  it('GET /api/changes/:id should give an error when looking for an unknown change', async () => {
    const res = await requestWithSupertest.get('/api/changes/999999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find change with id=999999.');
  });

});