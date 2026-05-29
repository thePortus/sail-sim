const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('CommunityAtLocation Endpoints', () => {

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
    const communityResponse = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Community',
        description: 'This is a test community.',
        type: 'Test Type'
      });
    relatedIds.communityId = communityResponse.body.id;
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
    relatedIds.communityLocationId = communityLocationResponse.body.id;
  });


  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/communities-at-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete(`/api/communities/${relatedIds.communityId}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete(`/api/communities-locations/${relatedIds.communityLocationId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('CREATE /api/communities-at-locations should accept valid data from an owner', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('communityId');
    expect(res.body).toHaveProperty('communityLocationId');
    expect(res.body).toHaveProperty('startYear');
    expect(res.body).toHaveProperty('startMonth');
    expect(res.body).toHaveProperty('startDay');
    expect(res.body).toHaveProperty('endYear');
    expect(res.body).toHaveProperty('endMonth');
    expect(res.body).toHaveProperty('endDay');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities-at-locations should accept valid data from an admin', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${adminToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('communityId');
    expect(res.body).toHaveProperty('communityLocationId');
    expect(res.body).toHaveProperty('startYear');
    expect(res.body).toHaveProperty('startMonth');
    expect(res.body).toHaveProperty('startDay');
    expect(res.body).toHaveProperty('endYear');
    expect(res.body).toHaveProperty('endMonth');
    expect(res.body).toHaveProperty('endDay');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities-at-locations should accept valid data from an editor', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${editorToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('communityId');
    expect(res.body).toHaveProperty('communityLocationId');
    expect(res.body).toHaveProperty('startYear');
    expect(res.body).toHaveProperty('startMonth');
    expect(res.body).toHaveProperty('startDay');
    expect(res.body).toHaveProperty('endYear');
    expect(res.body).toHaveProperty('endMonth');
    expect(res.body).toHaveProperty('endDay');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities-at-locations should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/communities-at-locations should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${userToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/communities-at-locations should accept an item without a start months/days specified', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('communityId');
    expect(res.body).toHaveProperty('communityLocationId');
    expect(res.body).toHaveProperty('startYear');
    expect(res.body).toHaveProperty('startMonth');
    expect(res.body).toHaveProperty('startDay');
    expect(res.body).toHaveProperty('endYear');
    expect(res.body).toHaveProperty('endMonth');
    expect(res.body).toHaveProperty('endDay');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities-at-locations should accept an item without a end months/days specified', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        endYear: 1600,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('communityId');
    expect(res.body).toHaveProperty('communityLocationId');
    expect(res.body).toHaveProperty('startYear');
    expect(res.body).toHaveProperty('startMonth');
    expect(res.body).toHaveProperty('startDay');
    expect(res.body).toHaveProperty('endYear');
    expect(res.body).toHaveProperty('endMonth');
    expect(res.body).toHaveProperty('endDay');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities-at-locations should reject items without startYear', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'startYear\' field!']);
  });

  it('CREATE /api/communities-at-locations should reject items without communityId', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'communityId\' field!']);
  });

  it('CREATE /api/communities-at-locations should reject items without communityLocationId', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'communityLocationId\' field!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for communityId', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: 'test',
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'communityId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for communityLocationId', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: 'test',
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'communityLocationId\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for startYear', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 'test',
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'startYear\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for startMonth', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 'test',
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'startMonth\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for startDay', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 'test',
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'startDay\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for endYear', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 'test',
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'endYear\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for endMonth', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 'test',
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'endMonth\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-integer for endDay', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 'test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'endDay\' must be of type \'integer\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with a non-string for notes', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1600,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: 1600
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('CREATE /api/communities-at-locations should reject items with an end date that preceeds the start date', async () => {
    const res = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1701,
        startMonth: 1,
        startDay: 1,
        endYear: 1700,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Cannot create item, end date precedes starting date']);
  });

  // test for change logs
  it('CREATE /api/communities-at-locations should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: relatedIds.communityId,
        communityLocationId: relatedIds.communityLocationId,
        startYear: 1900,
        startMonth: 1,
        startDay: 1,
        endYear: 1950,
        endMonth: 1,
        endDay: 1,
        notes: ''
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=CommunitiesAtLocations&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});