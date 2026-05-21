const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('JesuitHoldingOffice Endpoints', () => {

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
    const eventLocationResponse = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Event Location',
        latitude: 1,
        longitude: 1,
        type: 'Test Type',
        isPrecise: true
      });
    relatedIds.eventLocation = eventLocationResponse.body.id;
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
    const firstCatalogResponse = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test First Catalog',
        jesuitId: relatedIds.jesuit,
        communityId: relatedIds.community,
        communityLocationId: relatedIds.communityLocation,
        communityAtLocationId: relatedIds.communityAtLocation,
        catalogYear: 2015,
        year: 2015,
        month: 1,
        day: 1,
        healthState: 'Healthy',
        healthStateExpanded: 'Healthy Expanded',
        entryKey: 1,
        entryKeyAttributed: false,
        sourceId: relatedIds.source,
        languageId: relatedIds.language
      });
    relatedIds.firstCatalog = firstCatalogResponse.body.id;
    const officeResponse = await requestWithSupertest
      .post('/api/offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Office',
        description: 'Test Description',
      });
    relatedIds.office = officeResponse.body.id;
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/jesuits-holding-offices/${createdId}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/offices/${relatedIds.office}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/first-catalogs/${relatedIds.firstCatalog}`)
      .set('Authorization', `${ownerToken}`);
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

  it('GET /api/jesuits-holding-offices should show all jesuits-holding-offices', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits-holding-offices?page=1&size=5 should show paginated jesuits-holding-offices', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits-holding-offices?page=1&size=5&officeId=9999 should filter items by officeId', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices?page=0&size=5&officeId=9999');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits-holding-offices?page=1&size=5&officeId=9999 should search for items by officeId', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices?page=0&size=5&officeId=1');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits-holding-offices?page=1&size=5&firstCatalogId=9999 should filter items by firstCatalogId', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices?page=0&size=5&firstCatalogId=9999');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits-holding-offices?page=1&size=5&firstCatalogId=9999 should search for items by firstCatalogId', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices?page=0&size=5&firstCatalogId=1');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits-holding-offices/:id should return a single jesuitHoldingOffice in full detail', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstCatalogId');
    expect(res.body).toHaveProperty('officeId');
    expect(res.body).toHaveProperty('appearsAs');
    expect(res.body).toHaveProperty('nonTranscribeable');
    expect(res.body).toHaveProperty('notes');
    expect(res.body).toHaveProperty('office');
    expect(res.body).toHaveProperty('firstCatalog');
    expect(res.body.office).toBeInstanceOf(Object);
    expect(res.body.firstCatalog).toBeInstanceOf(Object);
    
  });

  it('GET /api/jesuits-holding-offices/:id should give an error when looking for an unknown jesuitHoldingOffice', async () => {
    const res = await requestWithSupertest.get('/api/jesuits-holding-offices/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find JesuitHoldingOffice with id=9999.');
  });

});