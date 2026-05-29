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

  it('CREATE /api/first-catalogs should accept valid data by owner', async () => {
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
    expect(res.body).toHaveProperty('healthStateExpanded');
    expect(res.body).toHaveProperty('entryKey');
    expect(res.body).toHaveProperty('entryKeyAttributed');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/first-catalogs should accept valid data by admin', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${adminToken}`)
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
    expect(res.body).toHaveProperty('healthStateExpanded');
    expect(res.body).toHaveProperty('entryKey');
    expect(res.body).toHaveProperty('entryKeyAttributed');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/first-catalogs should accept valid data by editor', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${editorToken}`)
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
    expect(res.body).toHaveProperty('healthStateExpanded');
    expect(res.body).toHaveProperty('entryKey');
    expect(res.body).toHaveProperty('entryKeyAttributed');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/first-catalogs should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
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
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/first-catalogs should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${userToken}`)
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
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/first-catalogs should reject items without jesuitId', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'jesuitId\' field!']);
  });

  it('CREATE /api/first-catalogs should reject items without communityAtLocationId', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'communityAtLocationId\' field!']);
  });

  it('CREATE /api/first-catalogs should reject items without sourceId', async () => {
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
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'sourceId\' field!']);
  });

  it('CREATE /api/first-catalogs should reject items without languageId', async () => {
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
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'languageId\' field!']);
  });

  it('CREATE /api/first-catalogs should reject items without catalogYear', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': relatedIds.communityAtLocation,
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'catalogYear\' field!']);
  });

  it('CREATE /api/first-catalogs should reject items without year', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': relatedIds.communityAtLocation,
        'catalogYear': 1600,
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'year\' field!']);
  });

  it('CREATE /api/first-catalogs should reject items with jesuitIds that are not integers', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': '1',
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'jesuitId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with communityAtLocationId that are not integers', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': '1',
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'communityAtLocationId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with souceIds that are not integers', async () => {
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
        'sourceId': 'test',
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'sourceId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with languageIds that are not integers', async () => {
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
        'languageId': 'test',
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'languageId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with catalogYears that are not integers', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': relatedIds.communityAtLocation,
        'catalogYear': '1600',
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'catalogYear\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with years that are not integers', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': relatedIds.communityAtLocation,
        'catalogYear': 1600,
        'year': '1600',
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'year\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with months that are not integers', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': relatedIds.communityAtLocation,
        'catalogYear': 1600,
        'year': 1600,
        'month': '1',
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'month\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with day that are not integers', async () => {
    const res = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        'jesuitId': relatedIds.jesuit,
        'communityAtLocationId': relatedIds.communityAtLocation,
        'catalogYear': 1600,
        'year': 1600,
        'month': 1,
        'day': '1',
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
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'day\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with ages that are not integers', async () => {
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
        'age': '35',
        'healthState': 'Good',
        'healthStateExpanded': 'Very Good',
        'entryKey': 2025,
        'entryKeyAttributed': false,
        'sourceId': relatedIds.source,
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'age\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with healthStates that are not string', async () => {
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
        'healthState': 35,
        'healthStateExpanded': 'Very Good',
        'entryKey': 2025,
        'entryKeyAttributed': false,
        'sourceId': relatedIds.source,
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'healthState\' must be of type \'string\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with healthStateExpandeds that are not string', async () => {
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
        'healthStateExpanded': 35,
        'entryKey': 2025,
        'entryKeyAttributed': false,
        'sourceId': relatedIds.source,
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'healthStateExpanded\' must be of type \'string\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with entryKey that are not integers', async () => {
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
        'entryKey': '2025',
        'entryKeyAttributed': false,
        'sourceId': relatedIds.source,
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'entryKey\' must be of type \'integer\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with entryKeyAtrributed that are not booleans', async () => {
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
        'entryKeyAttributed': 'false',
        'sourceId': relatedIds.source,
        'page': '1v',
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'entryKeyAttributed\' must be of type \'boolean\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with pages that are not strings', async () => {
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
        'page': 1,
        'languageId': relatedIds.language,
        'notes': 'Test Notes'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'page\' must be of type \'string\'!']);
  });

  it('CREATE /api/first-catalogs should reject items with notes that are not strings', async () => {
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
        'notes': 25
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('CREATE /api/first-catalogs should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        jesuitId: relatedIds.jesuit,
        communityAtLocationId: relatedIds.communityAtLocation,
        catalogYear: 1600,
        year: 1600,
        month: 1,
        day: 1,
        age: 35,
        healthState: 'Good',
        healthStateExpanded: 'Very Good',
        entryKey: 2025,
        entryKeyAttributed: false,
        sourceId: relatedIds.source,
        page: '1v',
        languageId: relatedIds.language,
        notes: 'Test Notes'
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=FirstCatalogs&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});