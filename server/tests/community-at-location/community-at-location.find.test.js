const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('CommunityAtLocation Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let createdId = '';
  let relatedIds = {};

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
    const communityResponse = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Community',
        description: 'This is a test community.',
        type: 'Test Type'
      });
    relatedIds.communityId = communityResponse.body.id;
    const communityLocationResponse = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Location',
        assistancy: 'Test Assistancy',
        province: 'Test Province',
        city: 'Test City',
        latitude: 1,
        longitude: 1,
        isPrecise: true
      });
    relatedIds.communityLocationId = communityLocationResponse.body.id;
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/communities-at-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/communities/${relatedIds.communityId}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/communities-locations/${relatedIds.communityLocationId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/communities-at-locations should show all communities-at-locations', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5 should show paginated communities-at-locations', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should exclude items before the startYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1750');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should include items after the startYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1600');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should include items before the endYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&endYear=2024');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should include items between the startYear and the endYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1600&endYear=2024');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should exclude items before the startYear and endYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1400&endYear=1500');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should exclude items after the startYear and endYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1750&endYear=1800');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should include items totally between startYear and endYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1600&endYear=1750');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should include items with dates partially before and partially between startYear and endYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1550&endYear=1700');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz should include items with dates partially after and partially between startYear and endYear', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&startYear=1675endYear=1715');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz&communityId=9999 should filter items by communityId', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&communityId=9999');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz&communityLocationId=9999 should filter items by communityLocationId', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&communityLocationId=9999');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz&communityId=1 should search for items by communityId', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&communityId=' + relatedIds.communityId);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations?page=1&size=5&startDate=xyz&communityLocationId=1 should search for items by communityLocationId', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations?page=0&size=5&communityLocationId=' + relatedIds.communityLocationId);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/communities-at-locations/:id should return a single eventLocation in full detail', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('communityId');
    expect(res.body).toHaveProperty('communityLocationId');
    expect(res.body).toHaveProperty('startYear');
    expect(res.body).toHaveProperty('startMonth');
    expect(res.body).toHaveProperty('startDay');
    expect(res.body).toHaveProperty('endYear');
    expect(res.body).toHaveProperty('endMonth');
    expect(res.body).toHaveProperty('endDay');
    expect(res.body).toHaveProperty('notes');
    expect(res.body).toHaveProperty('community');
    expect(res.body).toHaveProperty('location');
    expect(res.body.community).toBeInstanceOf(Object);
    expect(res.body.location).toBeInstanceOf(Object);
    
  });

  it('GET /api/communities-at-locations/:id should give an error when looking for an unknown communityAtLocation', async () => {
    const res = await requestWithSupertest.get('/api/communities-at-locations/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find CommunityAtLocation with id=9999.');
  });

});