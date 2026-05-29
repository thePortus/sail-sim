const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('EventLocation Endpoints', () => {

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
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/event-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('DELETE /api/event-locations/:id should delete a single eventLocation by owner', async () => {
    const res = await requestWithSupertest.delete('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'EventLocation was deleted successfully!');
  });

  it('DELETE /api/event-locations/:id should delete a single eventLocation by admin', async () => {
    const res = await requestWithSupertest.delete('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'EventLocation was deleted successfully!');
  });

  it('DELETE /api/event-locations/:id should reject deleting an unknown eventLocation', async () => {
    const res = await requestWithSupertest.delete('/api/event-locations/9999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete eventLocation with id=9999. Maybe eventLocation was not found!');
  });

  it('DELETE /api/event-locations/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/event-locations/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/event-locations/:id should reject request by editors', async () => {
    const res = await requestWithSupertest.delete('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/event-locations/:id should reject request by regular users without privileges', async () => {
    const res = await requestWithSupertest.delete('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/event-locations/:id should reject deleting an eventLocation referenced by other tables', async () => {
    const languageResponse = await requestWithSupertest
      .post('/api/languages')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Testing Language with References'
      });
    const jesuitResponse = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Jesuit'
      });
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
    const firstCatalogResponse = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test First Catalog',
        jesuitId: jesuitResponse.body.id,
        communityId: communityResponse.body.id,
        communityLocationId: communityLocationResponse.body.id,
        communityAtLocationId: communityAtLocationResponse.body.id,
        catalogYear: 2015,
        year: 2015,
        month: 1,
        day: 1,
        healthState: 'Healthy',
        healthStateExpanded: 'Healthy Expanded',
        entryKey: 1,
        entryKeyAttributed: false,
        sourceId: sourceResponse.body.id,
        languageId: languageResponse.body.id,
      });
    const lifeEventResponse = await requestWithSupertest
      .post('/api/life-events')
      .set('Authorization', `${ownerToken}`)
      .send({
        eventLocationId: createdId,
        firstCatalogId: firstCatalogResponse.body.id,
        title: 'Test Event',
        year: 2021,
        month: 1,
        day: 1,
        calculated: false,
        trustAsCanonical: true,
        notes: 'Test notes'
      });
  
    // Attempt to delete the EventLocation
    const res = await requestWithSupertest
      .delete('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
  
    // Assert the response
    expect(res.status).toEqual(400);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete EventLocation due to existing references in other tables');
    await requestWithSupertest.delete(`/api/life-events/${lifeEventResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/first-catalogs/${firstCatalogResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/communities-at-locations/${communityAtLocationResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/community-locations/${communityLocationResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/communities/${communityResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/sources/${sourceResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/languages/${languageResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/jesuits/${jesuitResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });
  
  // test for change logs
  it('DELETE /api/event-locations/:id should log a change', async () => {
    await requestWithSupertest.delete('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=EventLocations&action=Delete&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });
});