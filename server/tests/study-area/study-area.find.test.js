const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('StudyArea Endpoints', () => {

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
      .post('/api/study-areas')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test StudyArea',
        description: 'Test Description',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/study-areas/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/study-areas should show all study areas', async () => {
    const res = await requestWithSupertest.get('/api/study-areas');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/study-areas?page=1&size=5 should show paginated study areas', async () => {
    const res = await requestWithSupertest.get('/api/study-areas?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/study-areas?page=1&size=5&title=xyz should filter by title', async () => {
    const res = await requestWithSupertest.get('/api/study-areas?page=0&size=5&title=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/study-areas/:id should return a single study area in full detail', async () => {
    const res = await requestWithSupertest.get('/api/study-areas/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('description');
    expect(res.body).toHaveProperty('catalogRecords');
    expect(res.body).toHaveProperty('notes');
    expect(res.body.catalogRecords).toBeInstanceOf(Array);
  });

  it('GET /api/study-areas/:id should give an error when looking for an unknown study area', async () => {
    const res = await requestWithSupertest.get('/api/study-areas/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find StudyArea with id=9999.');
  });

});