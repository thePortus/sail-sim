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
    const studyAreaResponse = await requestWithSupertest
      .post('/api/study-areas')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Study Area',
        description: 'Test Description',
      });
    relatedIds.studyArea = studyAreaResponse.body.id;
    const officeResponse = await requestWithSupertest
      .post('/api/offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Office',
        description: 'Test Description',
      });
    relatedIds.office = officeResponse.body.id;
    const jesuitStudyingAreaResponse = await requestWithSupertest
      .post('/api/jesuits-studying-areas')
      .set('Authorization', `${ownerToken}`)
      .send({
        studyAreaId: relatedIds.studyArea,
        firstCatalogId: createdId,
        duration: '1 year',
      });
    relatedIds.jesuitStudyArea = jesuitStudyingAreaResponse.body.id;
    const jesuitOfficeResponse = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        officeId: relatedIds.office,
        firstCatalogId: createdId
      });
    relatedIds.jesuitOffice = jesuitOfficeResponse.body.id;
    const eventLocationResponse = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Event Location',
        assistancy: 'Test Assistancy',
        province: 'Test Province',
        city: 'Test City',
        latitude: 1,
        longitude: 1,
        isPrecise: true
      });
    relatedIds.eventLocation = eventLocationResponse.body.id;
    const lifeEventResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalogId,
        eventLocationId: relatedIds.eventLocation,
        title: 'Test',
        year: 1600,
        month: 1,
        day: 1,
        calculated: false,
        trustAsCanonical: false
      });
    relatedIds.lifeEvent = lifeEventResponse.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/jesuits-studying-areas/${relatedIds.jesuitStudyArea}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/jesuits-holding-offices/${relatedIds.jesuitOffice}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/study-areas/${relatedIds.studyArea}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/offices/${relatedIds.office}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/first-catalogs/${createdId}`)
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

  it('GET /api/first-catalogs should show all first-catalogs', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5 should show paginated first-catalogs', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&healthState=xyz should filter by healthState', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&healthState=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&age=xyz should filter by age', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&age=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&firstName=xyz should filter by firstName', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&firstName=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&firstName=Test should return results searching by firstName', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&firstName=Test');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&lastName=xyz should filter by lastName', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&lastName=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&lastName=Test should return results searching by lastName', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&lastName=Test');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&language=xyz should filter by language', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&language=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&language=Test Language should return results searching by language', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&language=Test%20Language');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&source=xyz should filter by source', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&source=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&source=Test should return results searching by source', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&source=Test');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&location=xyz should filter by location', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&location=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&location=London should return results searching by location', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&location=Location');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&community=xyz should filter by community', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&community=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&community=Community should return results searching by community', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&community=Community');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&office=xyz should filter by office', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&office=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&office=Office should return results searching by office', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&office=Office');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&study=xyz should filter by area of study', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&study=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs?page=1&size=5&study=Study should return results searching by area of study', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&study=Study');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&startYear=1550&endYear=1650 should return results', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&startYear=1550&endYear=1650');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&startYear=1550 should return results', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&startYear=1550');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&endYear=2050 should return results', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&endYear=2050');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/first-catalogs?page=1&size=5&startYear=2050&endYear=2051 should return no results', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs?page=0&size=5&startYear=2050&endYear=2051');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/first-catalogs/:id should return a single firstCatalog in full detail', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('jesuitId');
    expect(res.body).toHaveProperty('communityAtLocationId');
    expect(res.body).toHaveProperty('catalogYear');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('day');
    expect(res.body).toHaveProperty('age');
    expect(res.body).toHaveProperty('healthState');
    expect(res.body).toHaveProperty('entryKey');
    expect(res.body).toHaveProperty('entryKeyAttributed');
    expect(res.body).toHaveProperty('sourceId');
    expect(res.body).toHaveProperty('jesuit');
    expect(res.body).toHaveProperty('communityLocation');
    expect(res.body.communityLocation).toHaveProperty('community');
    expect(res.body.communityLocation).toHaveProperty('location');
    expect(res.body).toHaveProperty('offices');
    expect(res.body).toHaveProperty('studyAreas');
    expect(res.body).toHaveProperty('language');
    expect(res.body).toHaveProperty('source');
    expect(res.body).toHaveProperty('notes');
    expect(res.body.communityLocation).toBeInstanceOf(Object);
    expect(res.body.communityLocation.community).toBeInstanceOf(Object);
    expect(res.body.communityLocation.location).toBeInstanceOf(Object);
    expect(res.body.offices).toBeInstanceOf(Array);
    expect(res.body.studyAreas).toBeInstanceOf(Array);
    expect(res.body.language).toBeInstanceOf(Object);
    expect(res.body.source).toBeInstanceOf(Object);
  });

  it('GET /api/first-catalogs/:id should give an error when looking for an unknown firstCatalog', async () => {
    const res = await requestWithSupertest.get('/api/first-catalogs/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find FirstCatalog with id=9999.');
  });

});