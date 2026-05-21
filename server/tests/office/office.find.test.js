const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Office Find Endpoints', () => {

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
      .post('/api/offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Office',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/offices/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/offices should show all offices', async () => {
    const res = await requestWithSupertest.get('/api/offices');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/offices?page=1&size=5 should show paginated offices', async () => {
    const res = await requestWithSupertest.get('/api/offices?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/offices?page=1&size=5&title=xyz should filter by title', async () => {
    const res = await requestWithSupertest.get('/api/offices?page=0&size=5&title=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/offices/:id should return a single office in full detail', async () => {
    const res = await requestWithSupertest.get('/api/offices/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('firstCatalog');
    expect(res.body).toHaveProperty('notes');
    expect(res.body.firstCatalog).toBeInstanceOf(Array);
  });

  it('GET /api/offices/:id should give an error when looking for an unknown office', async () => {
    const res = await requestWithSupertest.get('/api/offices/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find office with id=9999.');
  });

});