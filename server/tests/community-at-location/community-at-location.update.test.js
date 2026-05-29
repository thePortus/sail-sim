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

  beforeEach(async () => {
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
    createdId = res.body.id;
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

  it('UPDATE /api/communities-at-locations/:id should update a single eventLocation by owner', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        startYear: 1602,
        startMonth: 2
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityAtLocation was updated successfully.');
  });

  it('UPDATE /api/communities-at-locations/:id should update a single eventLocation by admin', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        startYear: 1602,
        startMonth: 2
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityAtLocation was updated successfully.');
  });

  it('UPDATE /api/communities-at-locations/:id should update a single eventLocation by editor', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        startYear: 1602,
        startMonth: 2
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityAtLocation was updated successfully.');
  });

  it('UPDATE /api/communities-at-locations/:id should update reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/communities-at-locations/:id should update reject request by regular users without privileges', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/communities-at-locations/:id should update reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        id: '9999',
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(404);
    expect(res.body).toHaveProperty('message', 'Cannot update CommunityAtLocation with id=9999. Maybe CommunityAtLocation was not found!');
  });

  it('UPDATE /api/communities-at-locations/:id should update reject request whose end year preceeds its start year', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        startYear: 1700,
        endYear: 1600
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', [`Cannot update CommunityAtLocation with id=${createdId}, end date precedes starting date`]);
  });

  it('UPDATE /api/communities-at-locations/:id should update reject request whose end month preceeds its start month (of the same year)', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        startYear: 1600,
        endYear: 1600,
        startMonth: 2,
        endMonth: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', [`Cannot update CommunityAtLocation with id=${createdId}, end date precedes starting date`]);
  });

  it('UPDATE /api/communities-at-locations/:id should update reject request whose end month preceeds its start month (of the same year)', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        startYear: 1600,
        endYear: 1600,
        startMonth: 1,
        endMonth: 1,
        startDay: 2,
        endDay: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', [`Cannot update CommunityAtLocation with id=${createdId}, end date precedes starting date`]);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for communityId', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'communityId\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for communityLocationId', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        communityLocationId: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'communityLocationId\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for startYear', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        startYear: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'startYear\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for startMonth', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        startMonth: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'startMonth\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for startDay', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        startDay: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'startDay\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for endYear', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        endYear: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'endYear\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for endMonth', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        endMonth: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'endMonth\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-integer for endDay', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        endDay: 'test'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'endDay\' must be of type \'integer\'!']);
  });

  it('UPDATE /api/communities-at-locations/:id should reject request with a non-string for notes', async () => {
    const res = await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: 3
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('UPDATE /api/-at-locations/:id should log a change', async () => {
    await requestWithSupertest.put('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        endYear: 1951,
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=CommunitiesAtLocations&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});