const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('MonetaryEntry Update Endpoints', () => {

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
    const monetaryColumnResponse = await requestWithSupertest
      .post('/api/monetary-columns')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Monetary Column',
      });
    relatedIds.monetaryColumn = monetaryColumnResponse.body.id;
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
    const thirdCatalogResponse = await requestWithSupertest
      .post('/api/third-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityAtLocationId: relatedIds.communityAtLocation,
        catalogYear: 2015,
        year: 2015,
        month: 1,
        day: 1,
        sourceId: relatedIds.source
      });
    relatedIds.thirdCatalog = thirdCatalogResponse.body.id;
  });

  beforeEach(async () => {
    const res = await requestWithSupertest
      .post('/api/monetary-entries')
      .set('Authorization', `${ownerToken}`)
      .send({
        monetaryColumnId: relatedIds.monetaryColumn,
        thirdCatalogId: relatedIds.thirdCatalog,
        description: 'Test description'
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    const res = await requestWithSupertest
      .delete(`/api/monetary-entries/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete('/api/monetary-entries/' + relatedIds.monetaryEntry)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/monetary-columns/' + relatedIds.monetaryColumn)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/third-catalogs/' + relatedIds.thirdCatalog)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/sources/' + relatedIds.source)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/communities-at-locations/' + relatedIds.communityAtLocation)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/community-locations/' + relatedIds.communityLocation)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest
      .delete('/api/communities/' + relatedIds.community)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/monetary-entries/:id should update a single monetary-entry from an owner', async () => {
    const res = await requestWithSupertest.put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        description: 'Testing description'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'MonetaryEntry was updated successfully.');
  });

  it('UPDATE /api/monetary-entries/:id should update a single monetary-entry from an admin', async () => {
    const res = await requestWithSupertest.put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        description: 'Testing description'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'MonetaryEntry was updated successfully.');
  });

  it('UPDATE /api/monetary-entries/:id should update a request from an editor', async () => {
    const res = await requestWithSupertest.put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        description: 'Testing description'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'MonetaryEntry was updated successfully.');
  });

  it('UPDATE /api/monetary-entries/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/monetary-entries/' + createdId.toString())
      .send({
        description: 'Testing description'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/monetary-entries/:id should reject request from regular users with no privileges', async () => {
    const res = await requestWithSupertest.put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        description: 'Testing description'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/monetary-entries/:id should reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/monetary-entries/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        description: 'Testing description'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update monetaryEntry with id=9999. Maybe monetaryEntry was not found!');
  });

  it('UPDATE /api/monetary-entries should reject items with monetaryColumnIds that are not numbers', async () => {
    const res = await requestWithSupertest
      .put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        monetaryColumnId: 'test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'monetaryColumnId\' must be of type \'number\'!']);
  });

  it('UPDATE /api/monetary-entries should reject items with thirdCatalogIds that are not numbers', async () => {
    const res = await requestWithSupertest
      .put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        thirdCatalogId: 'test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'thirdCatalogId\' must be of type \'number\'!']);
  });

  it('UPDATE /api/monetary-entries should reject items with descriptions that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        description: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'description\' must be of type \'string\'!']);
  });

  it('UPDATE /api/monetary-entries should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('UPDATE /api/monetary-entries/:id should log a change', async () => {
    await requestWithSupertest.put('/api/monetary-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        description: 'Updated description'
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=MonetaryEntries&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});