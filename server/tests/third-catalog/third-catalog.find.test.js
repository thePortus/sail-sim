const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('ThirdCatalog Find Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let createdId = '';
  let relatedIds = {};

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
    const communityResponse = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Community',
        type: 'Test Type'
      });
    relatedIds.community = communityResponse.body.id;
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
    relatedIds.communityLocation = communityLocationResponse.body.id;
    const communityAtLocationResponse = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.community,
        communityLocationId: relatedIds.communityLocation,
        startYear: 2000,
        startMonth: 1,
        startDay: 1,
        endYear: 2020,
        endMonth: 1,
        endDay: 1
      });
    relatedIds.communityAtLocation = communityAtLocationResponse.body.id;
    const sourceResponse = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Source',
        volume: 'Test Volume',
        page: '1',
        url: 'http://example.com',
        idBox: '1',
        archive: 'ARSI'
      });
    relatedIds.source = sourceResponse.body.id;
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1,
        sourceId: relatedIds.source
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/third-catalogs/${createdId}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/sources/' + relatedIds.source)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/communities-at-locations/' + relatedIds.communityAtLocation)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/community-locations/' + relatedIds.communityLocation)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/communities/' + relatedIds.community)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/third-catalogs should show all third-catalogs', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/third-catalogs?page=1&size=5 should show paginated third-catalogs', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/third-catalogs/:id should return a single third-catalog in full detail', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('communityAtLocationId');
    expect(res.body).toHaveProperty('sourceId');
    expect(res.body).toHaveProperty('catalogYear');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('day');
    expect(res.body).toHaveProperty('notes');
  });


  it('GET /api/third-catalogs?page=1&size=5&startYear=1550&endYear=1650 should return results', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs?page=0&size=5&startYear=1550&endYear=1650');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/third-catalogs?page=1&size=5&startYear=1550 should return results', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs?page=0&size=5&startYear=1550');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/third-catalogs?page=1&size=5&endYear=2050 should return results', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs?page=0&size=5&endYear=2050');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/third-catalogs?page=1&size=5&startYear=2050&endYear=2051 should return no results', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs?page=0&size=5&startYear=2050&endYear=2051');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/third-catalogs/:id should give an error when looking for an unknown third-catalog', async () => {
    const res = await requestWithSupertest.get('/api/third-catalogs/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find thirdCatalog with id=9999.');
  });

});