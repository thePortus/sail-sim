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

  it('CREATE /api/life-events should accept valid data from owner', async () => {
    const res = await requestWithSupertest
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
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('eventLocationId');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('calculated');
    expect(res.body).toHaveProperty('trustAsCanonical');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/life-events should accept valid data from admin', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${adminToken}`)
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
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('eventLocationId');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('calculated');
    expect(res.body).toHaveProperty('trustAsCanonical');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/life-events should accept valid data from editor', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${editorToken}`)
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
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('eventLocationId');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('calculated');
    expect(res.body).toHaveProperty('trustAsCanonical');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/life-events should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/life-events should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${userToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/life-events should reject items without title', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'title\' field!']);
  });

  it('CREATE /api/life-events should reject items without firstCatalogId', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 2,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'firstCatalogId\' field!']);
  });

  it('CREATE /api/life-events should reject items without eventLocationId', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'eventLocationId\' field!']);
  });

  it('CREATE /api/life-events should reject items without year', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'year\' field!']);
  });

  it('CREATE /api/life-events should reject items without month', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'month\' field!']);
  });

  it('CREATE /api/life-events should reject items without day', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'day\' field!']);
  });

  it('CREATE /api/life-events should reject items with titles that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 1,
        eventLocationId: relatedIds.eventLocation,
        firstCatalogId: relatedIds.firstCatalog,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('CREATE /api/life-events should reject items with a eventLocationId that is not an integer', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        eventLocationId: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'eventLocationId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/life-events should reject items with a firstCatalogId that is not an integer', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        eventLocationId: relatedIds.eventLocation,
        firstCatalogId: 'Test',
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'firstCatalogId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/life-events should reject items with a year that is not an integer', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 'Test',
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'year\' must be of type \'integer\'!']);
  });
  
  it('CREATE /api/life-events should reject items with a month that is not an integer', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 'Test',
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'month\' must be of type \'integer\'!']);
  });

  it('CREATE /api/life-events should reject items with a day that is not an integer', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'day\' must be of type \'integer\'!']);
  });

  it('CREATE /api/life-events should reject items with a notes that is not a string', async () => {
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
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('CREATE /api/life-events should reject items with trustAsCanonical set to true when there are already items with the same jesuitId and title which also have trustAsCanonical set to true', async () => {
    const duplicateResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Birth',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        trustAsCanonical: true,
        notes: ''
      });
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Birth',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 2,
        trustAsCanonical: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('messages', [`Cannot set trustAsCanonical to true for this event, as another event (id=${duplicateResponse.body.id}) for this Jesuit already has trustAsCanonical set to true for \"Birth\". Please unset trustAsCanonical for the other event first.`]);
    // cleanup
    await requestWithSupertest
      .delete(`/api/life-events/${duplicateResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('CREATE /api/life-events should create a new item with trustAsCanonical set to false if an item with the same jesuitId and title exists, but the new item either has no trustAsCanonical set, or it is set to false', async () => {
    const duplicateResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Birth',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        trustAsCanonical: true,
        notes: ''
      });
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Some Fake Event',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 3,
        trustAsCanonical: false,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('eventLocationId');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('calculated');
    expect(res.body.trustAsCanonical).toEqual(false);
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
    // cleanup
    await requestWithSupertest
      .delete(`/api/life-events/${duplicateResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });
  
  it('CREATE /api/life-events should create a new item with trustAsCanonical set to true if no item with the same jesuitId and title exists, and trustAsCanonical isn\'t explicitly set to false', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Testing if canonical is set to true (1)',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('eventLocationId');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('calculated');
    expect(res.body.trustAsCanonical).toEqual(true);
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });
  
  it('CREATE /api/life-events should create a new item with trustAsCanonical set to false if no item with the same jesuitId and title exists, and trustAsCanonical is explicitly set to false', async () => {
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Testing if canonical is set to true (2)',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        trustAsCanonical: false,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('eventLocationId');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('year');
    expect(res.body).toHaveProperty('month');
    expect(res.body).toHaveProperty('calculated');
    expect(res.body.trustAsCanonical).toEqual(false);
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/life-events should reject an attempt to create a new item if an event with the same firstCatalog and title exists on the same date (avoids duplicates)', async () => {
    const duplicateResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Birth',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    const res = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Birth',
        firstCatalogId: relatedIds.firstCatalog,
        eventLocationId: relatedIds.eventLocation,
        year: 1600,
        month: 1,
        day: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('messages', ['Cannot create event, as an event with the same title, day, month, year and firstCatalog already exists. Please update the existing event instead.']);
    await requestWithSupertest
      .delete(`/api/life-events/${duplicateResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });

  // test for change logs
  it('CREATE /api/life-events should log a change', async () => {
    const itemRes = await requestWithSupertest
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
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=LifeEvents&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});