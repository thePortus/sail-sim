const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('LifeEvent Endpoints', () => {

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
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        trustAsCanonical: true,
        notes: ''
      });
    createdId = res.body.id;
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/life-events/${createdId}`)
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

  it('GET /api/life-events should show all life-events', async () => {
    const res = await requestWithSupertest.get('/api/life-events');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/life-events?page=0&size=5 should show paginated life-events', async () => {
    const res = await requestWithSupertest.get('/api/life-events?page=0&size=5');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/life-events?page=0&size=5&title=xyz should filter by title', async () => {
    const res = await requestWithSupertest.get('/api/life-events?page=0&size=5&title=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/life-events?page=1&size=5&type=xyz should filter by calculated', async () => {
    const res = await requestWithSupertest.get('/api/life-events?page=0&size=5&calculated=xyz');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/life-events?page=1&size=5&trustAsCanonical=xyz should filter by trustAsCanonical', async () => {
    const res = await requestWithSupertest.get('/api/life-events?page=0&size=5&trustAsCanonical=true');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/life-events?page=1&size=5&yearEnd=xyz should filter by year', async () => {
    const res = await requestWithSupertest.get('/api/life-events?page=0&size=5&yearEnd=500');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/life-events?page=1&size=5&month=xyz should filter by month', async () => {
    const res = await requestWithSupertest.get('/api/life-events?page=0&size=5&month=13');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/life-events?page=1&size=5&day=xyz should filter by day', async () => {
    const res = await requestWithSupertest.get('/api/life-events?page=0&size=5&day=32');
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/life-events/:id should return a single eventLocation in full detail', async () => {
    const res = await requestWithSupertest.get('/api/life-events/' + createdId.toString());
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('firstCatalogId');
    expect(res.body).toHaveProperty('eventLocationId');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('day');
    expect(res.body).toHaveProperty('calculated');
    expect(res.body).toHaveProperty('trustAsCanonical');
    expect(res.body).toHaveProperty('firstCatalog');
    expect(res.body.firstCatalog).toBeInstanceOf(Object);
    expect(res.body.firstCatalog).toHaveProperty('jesuit');
    expect(res.body.firstCatalog.jesuit).toBeInstanceOf(Object);
    expect(res.body).toHaveProperty('location');
    expect(res.body.location).toBeInstanceOf(Object);
    expect(res.body).toHaveProperty('notes');
  });

  it('GET /api/life-events/:id should give an error when looking for an unknown event', async () => {
    const res = await requestWithSupertest.get('/api/life-events/9999');
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot find lifeEvent with id=9999.');
  });
  
});