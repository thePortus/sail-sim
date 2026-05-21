const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('CurrencyEntry Delete Endpoints', () => {

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
    const currencyResponse = await requestWithSupertest
      .post('/api/currencies')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Currency',
      });
    relatedIds.currency = currencyResponse.body.id;
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
    const monetaryEntryResponse = await requestWithSupertest
      .post('/api/monetary-entries')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Monetary Entry',
        monetaryColumnId: relatedIds.monetaryColumn,
        thirdCatalogId: relatedIds.thirdCatalog,
        description: 'Test description'
      });
    relatedIds.monetaryEntry = monetaryEntryResponse.body.id;
  });

  beforeEach(async () => {
    const res = await requestWithSupertest
      .post('/api/currency-entries')
      .set('Authorization', `${ownerToken}`)
      .send({
        monetaryEntryId: relatedIds.monetaryEntry,
        currencyId: relatedIds.currency,
        amount: 100,
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    const res = await requestWithSupertest
      .delete(`/api/currency-entries/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  afterAll(async () => {
    await requestWithSupertest
      .delete('/api/currencies/' + relatedIds.currency)
      .set('Authorization', `${ownerToken}`);
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

  it('DELETE /api/currency-entries/:id should delete a single currency-entry by an owner', async () => {
    const res = await requestWithSupertest.delete('/api/currency-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CurrencyEntry was deleted successfully!');
  });

  it('DELETE /api/currency-entries/:id should delete a single currency-entry by an admin', async () => {
    const res = await requestWithSupertest.delete('/api/currency-entries/' + createdId.toString())
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CurrencyEntry was deleted successfully!');
  });

  it('DELETE /api/currency-entries/:id should reject a request by an editor', async () => {
    const res = await requestWithSupertest.delete('/api/currency-entries/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CurrencyEntry was deleted successfully!');
  });

  it('DELETE /api/currency-entries/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/currency-entries/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/currency-entries/:id should reject deleting an unknown currency-entry', async () => {
    const res = await requestWithSupertest.delete('/api/currency-entries/9999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete currencyEntry with id=9999. Maybe currencyEntry was not found!');
  });

  it('DELETE /api/currency-entries/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/currency-entries/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/currency-entries/:id should reject request from a regular user without elevated privileges', async () => {
    const res = await requestWithSupertest.delete('/api/currency-entries/' + createdId.toString())
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/currency-entries/:id should log a change', async () => {
    await requestWithSupertest.delete('/api/currency-entries/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=CurrencyEntries&action=Delete&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});