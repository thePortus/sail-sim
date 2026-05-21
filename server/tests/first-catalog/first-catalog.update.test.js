const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('FirstCatalog Endpoints', () => {

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
    const jesuitResponse = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Test',
        notes: ''
      });
    relatedIds.jesuit = jesuitResponse.body.id;
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
    const languageResponse = await requestWithSupertest
      .post('/api/languages')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Language'
      });
    relatedIds.language = languageResponse.body.id;
  });

  beforeEach(async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': relatedIds.communityAtLocation,
        'catalogYear': 1600,
        'year': 1600,
        'month': 1,
        'day': 1,
        'age': 35,
        'healthState': 'Good',
        'healthStateExpanded': 'Very Good',
        'entryKey': 2025,
        'entryKeyAttributed': false,
        'sourceId': relatedIds.source,
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    let test = await requestWithSupertest
      .delete(`/api/first-catalogs/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/languages/${relatedIds.language}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/sources/${relatedIds.source}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/communities-at-locations/${relatedIds.communityAtLocation}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/community-locations/${relatedIds.communityLocation}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/communities/${relatedIds.community}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/jesuits/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/first-catalogs/:id should update a single firstCatalog by owner', async () => {
    const res = await requestWithSupertest.put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        healthState: 'Updated Test',
        age: 35,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'FirstCatalog was updated successfully.');
  });

  it('UPDATE /api/first-catalogs/:id should update a single firstCatalog by admin', async () => {
    const res = await requestWithSupertest.put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        healthState: 'Updated Test',
        age: 35,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'FirstCatalog was updated successfully.');
  });

  it('UPDATE /api/first-catalogs/:id should update a single firstCatalog by editor', async () => {
    const res = await requestWithSupertest.put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        healthState: 'Updated Test',
        age: 35,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'FirstCatalog was updated successfully.');
  });

  it('UPDATE /api/first-catalogs/:id should update reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/first-catalogs/' + createdId.toString())
      .send({
        healthState: 'Updated Test',
        age: 35,
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/first-catalogs/:id should update reject request by regular users without privileges', async () => {
    const res = await requestWithSupertest.put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        healthState: 'Updated Test',
        age: 35,
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/first-catalogs/:id should update reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/first-catalogs/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        healthState: 'Updated Test',
        age: 35,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update FirstCatalog with id=9999. Maybe FirstCatalog was not found!');
  });

  it('UPDATE /api/first-catalogs should reject items with jesuitIds that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        jesuitId: '123'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'jesuitId\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with communityAtLocationIds that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: '123'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'communityAtLocationId\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with catalogYears that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        catalogYear: '123'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'catalogYear\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with years that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        year: '123'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'year\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with months that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        month: '123'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'month\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with days that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        day: '123'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'day\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with ages that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        age: '35'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'age\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with healthStates that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        healthState: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'healthState\' must be of type \'string\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with healthStateExpanded that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        healthStateExpanded: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'healthStateExpanded\' must be of type \'string\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with entryKeys that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        entryKey: '123'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'entryKey\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with entryKeyAttributes that are not boolean', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        entryKeyAttributed: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'entryKeyAttributed\' must be of type \'boolean\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with sourceIds that are not integers', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        sourceId: '1'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'sourceId\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with pages that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        page: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'page\' must be of type \'string\'!']);
  });

  it('UPDATE /api/first-catalogs should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/first-catalogs/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

});