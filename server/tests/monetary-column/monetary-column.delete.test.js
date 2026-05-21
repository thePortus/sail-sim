const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('MonetaryColumn Delete Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let createdId = '';

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
  });

  beforeEach(async () => {
    const res = await requestWithSupertest
      .post('/api/monetary-columns')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test MonetaryColumn',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/monetary-columns/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('DELETE /api/monetary-columns/:id should delete a single monetary-column by an owner', async () => {
    const res = await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'MonetaryColumn was deleted successfully!');
  });

  it('DELETE /api/monetary-columns/:id should delete a single monetary-column by an admin', async () => {
    const res = await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'MonetaryColumn was deleted successfully!');
  });

  it('DELETE /api/monetary-columns/:id should reject a request by an editor', async () => {
    const res = await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/monetary-columns/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/monetary-columns/:id should reject deleting an unknown monetary-column', async () => {
    const res = await requestWithSupertest.delete('/api/monetary-columns/9999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete monetaryColumn with id=9999. Maybe monetaryColumn was not found!');
  });

  it('DELETE /api/monetary-columns/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/monetary-columns/:id should reject request from a regular user without elevated privileges', async () => {
    const res = await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/monetary-columns/:id should reject deleting a monetary-column referenced by other tables', async () => {
    const sourceResponse = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        idBox: 'Test Box',
        archive: 'Test Archive, Offices',
        volume: 'Test Volume',
        page: 'Test Page',
      });
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
    const communityResponse = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Community',
        type: 'Test Type'
      });
    const communityAtLocationResponse = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: communityResponse.body.id,
        communityLocationId: communityLocationResponse.body.id,
        startYear: 2000,
        startMonth: 1,
        startDay: 1,
        endYear: 2020,
        endMonth: 1,
        endDay: 1
      });
    const thirdCatalogResponse = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Third Catalog',
        communityAtLocationId: communityAtLocationResponse.body.id,
        catalogYear: 2015,
        year: 2015,
        month: 1,
        day: 1,
        sourceId: sourceResponse.body.id
      });
    const monetaryEntryResponse = await requestWithSupertest
      .post('/api/monetary-entries')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Monetary Entry',
        monetaryColumnId: createdId,
        thirdCatalogId: thirdCatalogResponse.body.id,
        description: 'Test description'
      });
    const res = await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete MonetaryColumn due to existing references in other tables');
    await requestWithSupertest.delete(`/api/monetary-entries/${monetaryEntryResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/third-catalogs/${thirdCatalogResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/communities-at-locations/${communityAtLocationResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/community-locations/${communityLocationResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/communities/${communityResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/sources/${sourceResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('DELETE /api/monetary-columns/:id should log a change', async () => {
    await requestWithSupertest.delete('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=MonetaryColumns&action=Delete&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});