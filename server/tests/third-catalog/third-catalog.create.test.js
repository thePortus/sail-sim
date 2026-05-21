const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('MonetaryEntry Create Endpoints', () => {

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
  });

  afterEach(async () => {
    const res = await requestWithSupertest
      .delete(`/api/third-catalogs/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  afterAll(async () => {
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

  it('CREATE /api/third-catalogs should accept valid data from an owner', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('communityAtLocationId');
    expect(res.body).toHaveProperty('sourceId');
    expect(res.body).toHaveProperty('catalogYear');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('day');
    createdId = res.body.id;
  });

  it('CREATE /api/third-catalogs should accept valid data from an admin', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${adminToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('communityAtLocationId');
    expect(res.body).toHaveProperty('sourceId');
    expect(res.body).toHaveProperty('catalogYear');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('day');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/third-catalogs should accept request from editor', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${editorToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('communityAtLocationId');
    expect(res.body).toHaveProperty('sourceId');
    expect(res.body).toHaveProperty('catalogYear');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('day');
    createdId = res.body.id;
  });

  it('CREATE /api/third-catalogs should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/third-catalogs should reject request from regular users with no privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${userToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/third-catalogs should reject items without communityAtLocationId', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'communityAtLocationId\' field!']);
  });

  it('CREATE /api/third-catalogs should reject items without sourceId', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'sourceId\' field!']);
  });

  it('CREATE /api/third-catalogs should reject items with catalogYears that are not numbers', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: '1600',
        year: 1600,
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'catalogYear\' must be of type \'number\'!']);
  });

  it('CREATE /api/third-catalogs should reject items with years that are not numbers', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: '1600',
        month: 1,
        day: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'year\' must be of type \'number\'!']);
  });

  it('CREATE /api/third-catalogs should reject items with months that are not numbers', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: '1',
        day: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'month\' must be of type \'number\'!']);
  });

  it('CREATE /api/third-catalogs should reject items with days that are not numbers', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: '1'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'day\' must be of type \'number\'!']);
  });

  it('CREATE /api/third-catalogs should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1,
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('CREATE /api/third-catalogs should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        sourceId: relatedIds.source,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=ThirdCatalogs&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});