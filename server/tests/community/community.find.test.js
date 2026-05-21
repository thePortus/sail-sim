const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Community Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let createdId = '';

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
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/communities/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/communities should show all communities', async () => {
    const res = await requestWithSupertest.get('/api/communities');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities?page=1&size=5 should show paginated communities', async () => {
    const res = await requestWithSupertest.get('/api/communities?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities?page=1&size=5&title=xyz should filter by title', async () => {
    const res = await requestWithSupertest.get('/api/communities?page=0&size=5&title=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/communities?page=1&size=5&type=xyz should filter by type', async () => {
    const res = await requestWithSupertest.get('/api/communities?page=0&size=5&type=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/communities/:id should return a single community in full detail', async () => {
    const res = await requestWithSupertest.get('/api/communities/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('description');
    expect(res.body).toHaveProperty('locations');
    expect(res.body).toHaveProperty('notes');
    expect(res.body.locations).toBeInstanceOf(Array);
  });

  it('GET /api/communities/:id should give an error when looking for an unknown community', async () => {
    const res = await requestWithSupertest.get('/api/communities/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find community with id=9999.');
  });

});