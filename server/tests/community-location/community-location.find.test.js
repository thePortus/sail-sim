const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Community Location Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let createdId = '';

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
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/community-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/community-locations should show all community locations', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/community-locations?page=1&size=5 should show paginated community locations', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/community-locations?page=1&size=5&title=xyz should filter by title', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations?page=0&size=5&title=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/community-locations?page=1&size=5&assistancy=xyz should filter by assistancy', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations?page=0&size=5&assistancy=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/community-locations?page=1&size=5&province=xyz should filter by province', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations?page=0&size=5&province=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/community-locations?page=1&size=5&city=xyz should filter by city', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations?page=0&size=5&city=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/community-locations?page=1&size=5&isPrecise=true should filter by isPrecise', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations?page=0&size=5&isPrecise=true');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/community-locations/:id should return a single community location in full detail', async () => {
    const res = await requestWithSupertest
      .get('/api/community-locations/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('assistancy');
    expect(res.body).toHaveProperty('province');
    expect(res.body).toHaveProperty('city');
    expect(res.body).toHaveProperty('latitude');
    expect(res.body).toHaveProperty('longitude');
    expect(res.body).toHaveProperty('isPrecise');
    expect(res.body).toHaveProperty('communities');
    expect(res.body).toHaveProperty('notes');
  });

  it('GET /api/community-locations/:id should give an error when looking for an unknown community location', async () => {
    const res = await requestWithSupertest.get('/api/community-locations/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find CommunityLocation with id=9999.');
  });

});