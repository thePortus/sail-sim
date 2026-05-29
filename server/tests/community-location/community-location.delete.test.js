const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Community Location Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let createdId = '';

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
  });

  beforeEach(async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/community-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('DELETE /api/community-locations/:id should delete a single community location by owner', async () => {
    const res = await requestWithSupertest.delete('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityLocation was deleted successfully!');
  });

  it('DELETE /api/community-locations/:id should delete a single community location by admin', async () => {
    const res = await requestWithSupertest.delete('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityLocation was deleted successfully!');
  });

  it('DELETE /api/community-locations/:id should reject deleting an unknown community location', async () => {
    const res = await requestWithSupertest.delete('/api/community-locations/9999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete CommunityLocation with id=9999. Maybe CommunityLocation was not found!');
  });

  it('DELETE /api/community-locations/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/community-locations/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/community-locations/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/community-locations/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/community-locations/:id should reject request by editors', async () => {
    const res = await requestWithSupertest.delete('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/community-locations/:id should reject request by regular users without privileges', async () => {
    const res = await requestWithSupertest.delete('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/community-locations/:id should reject deleting a community location referenced by other tables', async () => {
    const communityResponse = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Community',
        type: 'Test Type',
        description: 'Test Description',
      });
    const communityAtLocationResponse = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: communityResponse.body.id,
        communityLocationId: createdId,
        startYear: 2000,
        endYear: 2050,
        startMonth: 1,
        endMonth: 12,
        startDay: 1,
        endDay: 31,
      });
    const res = await requestWithSupertest.delete('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete CommunityLocation due to existing references in other tables');
    await requestWithSupertest.delete(`/api/communities-at-locations/${communityAtLocationResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/communities/${communityResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });

  // test for change logs
  it('DELETE /api/community-locations/:id should log a change', async () => {
    await requestWithSupertest.delete('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=CommunityLocations&action=Delete&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });
  
});