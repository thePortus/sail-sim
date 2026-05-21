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

  it('DELETE /api/communities-at-locations/:id should delete a single communityAtLocation by owner', async () => {
    const res = await requestWithSupertest.delete('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityAtLocation was deleted successfully!');
  });

  it('DELETE /api/communities-at-locations/:id should delete a single communityAtLocation by admin', async () => {
    const res = await requestWithSupertest.delete('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityAtLocation was deleted successfully!');
  });

  it('DELETE /api/communities-at-locations/:id should delete a single communityAtLocation by editor', async () => {
    const res = await requestWithSupertest.delete('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityAtLocation was deleted successfully!');
  });

  it('DELETE /api/communities-at-locations/:id should reject deleting an unknown communityAtLocation', async () => {
    const res = await requestWithSupertest.delete('/api/communities-at-locations/9999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete CommunityAtLocation with id=9999. Maybe CommunityAtLocation was not found!');
  });

  it('DELETE /api/communities-at-locations/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/communities-at-locations/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/communities-at-locations/:id should reject by regular users without privileges', async () => {
    const res = await requestWithSupertest.delete('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  // test for change logs
  it('DELETE /api/communities-at-locations/:id should log a change', async () => {
    await requestWithSupertest.delete('/api/communities-at-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=CommunitiesAtLocations&action=Delete&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});