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
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/jesuits-holding-offices/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  afterAll(async () => {
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

  it('CREATE /api/jesuits-holding-offices should accept valid data from an owner', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstCatalogId');
    expect(res.body).toHaveProperty('officeId');
    expect(res.body).toHaveProperty('appearsAs');
    expect(res.body).toHaveProperty('nonTranscribeable');
    createdId = res.body.id;
  });

  it('CREATE /api/jesuits-holding-offices should accept valid data from an admin', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${adminToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstCatalogId');
    expect(res.body).toHaveProperty('officeId');
    expect(res.body).toHaveProperty('appearsAs');
    expect(res.body).toHaveProperty('nonTranscribeable');
    createdId = res.body.id;
  });

  it('CREATE /api/jesuits-holding-offices should accept valid data from an editor', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${editorToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstCatalogId');
    expect(res.body).toHaveProperty('officeId');
    expect(res.body).toHaveProperty('appearsAs');
    expect(res.body).toHaveProperty('nonTranscribeable');
    createdId = res.body.id;
  });

  it('CREATE /api/jesuits-holding-offices should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/jesuits-holding-offices should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${userToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/jesuits-holding-offices should reject items without firstCatalogId', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'firstCatalogId\' field!']);
  });

  it('CREATE /api/jesuits-holding-offices should reject items without officeId', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'officeId\' field!']);
  });

  it('CREATE /api/jesuits-holding-offices should reject items with a non-integer for firstCatalogId', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: 'test',
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'firstCatalogId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/jesuits-holding-offices should reject items with a non-integer for officeId', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: 'Test',
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'officeId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/jesuits-holding-offices should reject items with a non-string for appearsAs', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 1,
        nonTranscribeable: false,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'appearsAs\' must be of type \'string\'!']);
  });

  it('CREATE /api/jesuits-holding-offices should reject items with a non-boolean for nonTranscribeable', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: 'false',
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'nonTranscribeable\' must be of type \'boolean\'!']);
  });

  it('CREATE /api/jesuits-holding-offices should reject items with a non-string for notes', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('CREATE /api/jesuits-holding-offices should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/jesuits-holding-offices')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: relatedIds.firstCatalog,
        officeId: relatedIds.office,
        appearsAs: 'Test',
        nonTranscribeable: false,
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=JesuitsHoldingOffices&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});