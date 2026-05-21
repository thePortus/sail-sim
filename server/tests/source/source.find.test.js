const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Source Endpoints', () => {

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
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        idBox: '12345',
        archive: 'Test Archive',
        volume: 'Test Volume',
        page: '4v',
        url: 'https://www.test.com',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/sources/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/sources should show all sources', async () => {
    const res = await requestWithSupertest.get('/api/sources');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/sources?page=1&size=5 should show paginated sources', async () => {
    const res = await requestWithSupertest.get('/api/sources?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/sources?page=1&size=5&archive=xyz should filter by archive', async () => {
    const res = await requestWithSupertest.get('/api/sources?page=0&size=5&archive=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/sources?page=1&size=5&idBox=xyz should filter by idBox', async () => {
    const res = await requestWithSupertest.get('/api/sources?page=0&size=5&idBox=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/sources/:id should return a single source in full detail', async () => {
    const res = await requestWithSupertest.get('/api/sources/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('idBox');
    expect(res.body).toHaveProperty('archive');
    expect(res.body).toHaveProperty('volume');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('firstCatalogRecords');
    expect(res.body).toHaveProperty('notes');
    expect(res.body.firstCatalogRecords).toBeInstanceOf(Array);
  });

  it('GET /api/sources/:id should give an error when looking for an unknown source', async () => {
    const res = await requestWithSupertest.get('/api/sources/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find source with id=9999.');
  });

});