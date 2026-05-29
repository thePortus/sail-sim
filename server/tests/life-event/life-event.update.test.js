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
  });

  beforeEach(async () => {
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

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/life-events/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  afterAll(async () => {
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

  it('UPDATE /api/life-events/:id should update a single event by owner', async () => {
    const res = await requestWithSupertest.put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'LifeEvent was updated successfully.');
  });

  it('UPDATE /api/life-events/:id should update a single event by admin', async () => {
    const res = await requestWithSupertest.put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        title: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'LifeEvent was updated successfully.');
  });

  it('UPDATE /api/life-events/:id should update a single event by editor', async () => {
    const res = await requestWithSupertest.put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        title: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'LifeEvent was updated successfully.');
  });

  it('UPDATE /api/life-events/:id should update reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/life-events/' + createdId.toString())
      .send({
        id: createdId,
        title: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/life-events/:id should update reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest.put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        id: createdId,
        title: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/life-events/:id should update reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/life-events/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        id: '9999',
        title: 'Updated Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update lifeEvent with id=9999. Maybe lifeEvent was not found!');
  });

  it('UPDATE /api/life-events:id should reject items with titles that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('UPDATE /api/life-events:id should reject items with a eventLocationId that is not an integer', async () => {
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        eventLocationId: 'Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'eventLocationId\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/life-events:id should reject items with a firstCatalogId that is not an integer', async () => {
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: 'Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'firstCatalogId\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/life-events:id should reject items with a year that is not an integer', async () => {
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        year: 'Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'year\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/life-events:id should reject items with a month that is not an integer', async () => {
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        month: 'Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'month\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/life-events:id should reject items with a day that is not an integer', async () => {
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        day: 'Test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'day\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/life-events:id should reject items with a notes that is not a string', async () => {
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });


  it('UPDATE /api/life-events/:id should reject an update which creates lifeEvents with overlapping dates', async () => {
    // create a second database item that does not (initially) overlap with the first
    const duplicateResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 2,
        trustAsCanonical: false,
        notes: ''
      });
    const res = await requestWithSupertest
      .put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        year: 1600,
        month: 1,
        day: 2,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message');
    expect(res.body.message).toMatch(/Cannot update lifeEvent with id=\d+. Another event for this Jesuit already exists with the same title, day, month, year \(id=\d+\). Please update the existing event instead./);
    // clean up
    await requestWithSupertest
      .delete(`/api/life-events/${duplicateResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    
  });

  it('UPDATE /api/life-events/:id should reject an update which creates more than one lifeEvent that is trusted as canonical for a given jesuit and event title', async () => {
    const duplicateResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 2,
        trustAsCanonical: false,
        notes: ''
      });

    const res = await requestWithSupertest
      .put('/api/life-events/' + duplicateResponse.body.id.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        trustAsCanonical: true
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', `Cannot set trustAsCanonical to true for this event, as another event (id=${createdId.toString()}) for this Jesuit already has trustAsCanonical set to true for \"Test\". Please unset trustAsCanonical for the other event first.`);
    // clean up
    await requestWithSupertest
      .delete(`/api/life-events/${duplicateResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });

  // test for change logs
  it('UPDATE /api/life-events/:id should log a change', async () => {
    await requestWithSupertest.put('/api/life-events/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Testing'
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=LifeEvents&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });
  
});