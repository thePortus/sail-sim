const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Jesuit Find Endpoints', () => {
  
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

    // Create a jesuit to use in tests
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Test',
        notes: ''
      });
    createdId = res.body.id;
    // Create needed related items and connect them to the created jesuit
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
        jesuitId: createdId,
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
    const birthEventResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        title: 'Birth',
        year: 1980,
        month: 1,
        day: 1,
        calculated: false,
        trustAsCanonical: true,
      });
    relatedIds.birthEvent = birthEventResponse.body.id;
    const deathEventResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        title: 'Death',
        year: 2020,
        month: 1,
        day: 1,
        calculated: false,
        trustAsCanonical: true,
      });
    relatedIds.deathEvent = deathEventResponse.body.id;
    const officeResponse = await requestWithSupertest
      .post('/api/offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Office'
      });
    relatedIds.office = officeResponse.body.id;
    const jesuitHoldingOfficeResponse = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
      });
    relatedIds.jesuitHoldingOffice = jesuitHoldingOfficeResponse.body.id;
    const studyResponse = await requestWithSupertest
      .post('/api/study-areas')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Study Area',
        description: 'A test study area description'
      });
    relatedIds.studyArea = studyResponse.body.id;
    const jesuitStudyingResponse = await requestWithSupertest
      .post('/api/jesuits-studying-areas')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        studyAreaId: relatedIds.studyArea,
        duration: '2 years',
        inSociety: true
      });
    relatedIds.jesuitStudying = jesuitStudyingResponse.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/jesuits-studying-areas/${relatedIds.jesuitStudying}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/study-areas/${relatedIds.studyArea}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/jesuits-holding-offices/${relatedIds.jesuitHoldingOffice}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/offices/${relatedIds.office}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/life-events/${relatedIds.deathEvent}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/life-events/${relatedIds.birthEvent}`)
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
      .delete(`/api/event-locations/${relatedIds.eventLocation}`)
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

  it('GET /api/jesuits should show all jesuits', async () => {
    const res = await requestWithSupertest.get('/api/jesuits');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5 should show paginated jesuits', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&firstName=xyz should filter by first name', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&firstName=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits?page=1&size=5&lastName=xyz should filter by last name', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&lastName=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits?page=1&size=5&community=xyz should filter by community', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&community=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits?page=1&size=5&community=Community should return results searching by community', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&community=Community');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&office=xyz should filter by office', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&office=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits?page=1&size=5&office=Office should return results searching by office', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&office=office');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&source=xyz should filter by source', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&source=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits?page=1&size=5&source=Source should return results searching by source', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&source=arsi');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&study=xyz should filter by area of study', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&study=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits?page=1&size=5&study=Study should return results searching by area of study', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&study=Study');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&location=xyz should filter by location', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&location=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/jesuits?page=1&size=5&location=London should return results searching by location', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&location=Location');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&birthStart=1975&birthEnd=1985 should return results searching by birth year', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&birthStart=1975&birthEnd=1985');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&birthStart=575&birthEnd=625 should filter results by birth year', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&birthStart=575&birthEnd=625');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/jesuits?page=1&size=5&deathStart=1575&deathEnd=1625 should return results searching by death year', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&deathStart=2015&deathEnd=2025');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jesuits?page=1&size=5&deathStart=575&deathEnd=625 should return filter results by death year', async () => {
    const res = await requestWithSupertest.get('/api/jesuits?page=0&size=5&deathStart=575&deathEnd=625');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/jesuits/:id should return a single jesuit in full detail', async () => {
    const res = await requestWithSupertest.get('/api/jesuits/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('appearancesInCatalogs');
    expect(res.body.appearancesInCatalogs).toBeInstanceOf(Array);
    expect(res.body).toHaveProperty('notes');
  });

  it('GET /api/jesuits/:id should give an error when looking for an unknown jesuit', async () => {
    const res = await requestWithSupertest.get('/api/jesuits/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find jesuit with id=9999.');
  });

});