define(["TFS/WorkItemTracking/Services", "TFS/WorkItemTracking/RestClient", "TFS/Work/RestClient", "q", "VSS/Controls", "VSS/Controls/StatusIndicator", "VSS/Controls/Dialogs"],
    function (_WorkItemServices, _WorkItemRestClient, workRestClient, Q, Controls, StatusIndicator, Dialogs) {

        var ctx = null;

        function getWorkItemFormService() {
            return _WorkItemServices.WorkItemFormService.getService();
        }

        function getApiUrl(method) {

            var collection = ctx.collection.uri;
            var project = ctx.project.name;
            var team = ctx.team.name;

            var url = collection + project + '/' + team + '/_apis/wit' + method;
            return url;
        }

        function callRestApi(method) {

            return VSS.getAccessToken()
                .then(function (accessToken) {

                    var url = getApiUrl(method);
                    return $.ajax({
                        url: url,
                        dataType: 'json',
                        headers: {
                            'Authorization': 'Basic ' + btoa("" + ":" + accessToken.token)
                        }
                    })
                });
        }

        function getTemplates(workItemTypes) {

            var requests = []
            workItemTypes.forEach(function (workItemType) {

                var request = callRestApi('/templates?workItemTypeName=' + workItemType);
                requests.push(request);
            }, this);

            return Q.all(requests)
                .then(function (templateTypes) {

                    var templates = [];
                    templateTypes.forEach(function (templateType) {
                        if (templateType.count > 0) {

                            templateType.value.forEach(function (element) {
                                templates.push(element)
                            }, this);
                        }
                    }, this);
                    return templates;
                });
        }

        function getTemplate(id) {
            return callRestApi('/templates/' + id);
        }

        function IsPropertyValid(taskTemplate, key) {
            if (taskTemplate.fields.hasOwnProperty(key) == false) {
                return false;
            }
            if (key.indexOf('System.Tags') >= 0) { //not supporting tags for now
                return false;
            }
            if (taskTemplate.fields[key].toLowerCase() == '@me') { //not supporting current identity
                return false;
            }
            if (taskTemplate.fields[key].toLowerCase() == '@currentiteration') { //not supporting current iteration
                return false;
            }

            return true;
        }

        function createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings) {
            var workItem = [];

            for (var key in taskTemplate.fields) {
                if (IsPropertyValid(taskTemplate, key)) {
                    workItem.push({ "op": "add", "path": "/fields/" + key, "value": taskTemplate.fields[key] })
                }
            }

            if (taskTemplate.fields['System.Title'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.Title", "value": currentWorkItem['System.Title'] })

            if (taskTemplate.fields['System.AreaPath'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.AreaPath", "value": currentWorkItem['System.AreaPath'] })

            if (taskTemplate.fields['System.IterationPath'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": currentWorkItem['System.IterationPath'] })
            else if (taskTemplate.fields['System.IterationPath'].toLowerCase() == '@currentiteration')
                workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": teamSettings.backlogIteration.name + teamSettings.defaultIteration.path })

            if (taskTemplate.fields['System.AssignedTo'] == null) {
                if (currentWorkItem['System.AssignedTo'] != null)
                    workItem.push({ "op": "add", "path": "/fields/System.AssignedTo", "value": currentWorkItem['System.AssignedTo'] })
            }
            else if (taskTemplate.fields['System.AssignedTo'].toLowerCase() == '@me')
                workItem.push({ "op": "add", "path": "/fields/System.AssignedTo", "value": ctx.user.uniqueName })

            return workItem;
        }

        function createWorkItem(service, currentWorkItem, taskTemplate, teamSettings) {

            var witClient = _WorkItemRestClient.getClient();

            var newWorkItem = createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings);

            witClient.createWorkItem(newWorkItem, VSS.getWebContext().project.name, taskTemplate.workItemTypeName)
                .then(function (response) {
                    //Add relation
                    if (service != null) {
                        service.addWorkItemRelations([
                            {
                                rel: "System.LinkTypes.Hierarchy-Forward",
                                url: response.url,
                            }]);
                        //Save 
                        service.beginSaveWorkItem(function (response) {
                            //WriteLog(" Saved");
                        }, function (error) {
                            ShowDialog(" Error saving: " + response);
                        });
                    } else {
                        //save using RestClient
                        var workItemId = currentWorkItem['System.Id']
                        var document = [{
                            op: "add",
                            path: '/relations/-',
                            value: {
                                rel: "System.LinkTypes.Hierarchy-Forward",
                                url: response.url,
                                attributes: {
                                    isLocked: false,
                                }
                            }
                        }];

                        witClient.updateWorkItem(document, workItemId)
                            .then(function (response) {
                                var a = response;
                                VSS.getService(VSS.ServiceIds.Navigation).then(function (navigationService) {
                                    navigationService.reload();
                                });
                            });
                    }
                });
        }

        function AddTasksOnForm(service) {

            var witClient = _WorkItemRestClient.getClient();
            var workClient = workRestClient.getClient();

            var team = {
                projectId: ctx.project.id,
                teamId: ctx.team.id
            }

            workClient.getTeamSettings(team).then(function (teamSettings) {
                // Get the current values for a few of the common fields
                service.getFieldValues(["System.Id", "System.Title", "System.State", "System.CreatedDate", "System.IterationPath", "System.AreaPath", "System.AssignedTo", "System.RelatedLinkCount", "System.WorkItemType"])
                    .then(function (value) {
                        var currentWorkItem = value

                        var workItemType = currentWorkItem["System.WorkItemType"];
                        GetChildTypes(witClient, workItemType)
                            .then(function (childTypes) {
                                if (childTypes == null)
                                    return;
                                // get Templates
                                getTemplates(childTypes)
                                    .then(function (response) {
                                        if (response.length == 0) {
                                            ShowDialog('No ' + childTypes + ' Templates found. Please add ' + childTypes + ' templates to the Project Team.')
                                            return;
                                        }
                                        // created childs alphabetical 
                                        var templates = response.sort(SortTemplates);
                                        var chain = Q.when();
                                        templates.forEach(function (template) {
                                            chain = chain.then(createChildFromtemplate(witClient, service, currentWorkItem, template, teamSettings));
                                        });
                                        return chain;

                                    })
                            });
                    })
            })
        }

        function AddTasksOnGrid(workItemId) {

            var witClient = _WorkItemRestClient.getClient();
            var workClient = workRestClient.getClient();

            var team = {
                projectId: ctx.project.id,
                teamId: ctx.team.id
            }

            workClient.getTeamSettings(team)
                .then(function (teamSettings) {
                    // Get the current values for a few of the common fields
                    witClient.getWorkItem(workItemId, ["System.Id", "System.Title", "System.State", "System.CreatedDate", "System.IterationPath", "System.AreaPath", "System.AssignedTo", "System.RelatedLinkCount", "System.WorkItemType"])
                        .then(function (value) {
                            var currentWorkItem = value.fields

                            var workItemType = currentWorkItem["System.WorkItemType"];
                            GetChildTypes(witClient, workItemType)
                                .then(function (childTypes) {


                                    if (childTypes == null)
                                        return;
                                    // get Templates
                                    getTemplates(childTypes)
                                        .then(function (response) {
                                            if (response.length == 0) {
                                                ShowDialog('No ' + childTypes + ' Templates found. Please add ' + childTypes + ' templates to the Project Team.')
                                                return;
                                            }
                                            // created childs alphabetical 
                                            var templates = response.sort(SortTemplates);
                                            var chain = Q.when();
                                            templates.forEach(function (template) {
                                                chain = chain.then(createChildFromtemplate(witClient, null, currentWorkItem, template, teamSettings));
                                            });
                                            return chain;

                                        })
                                });
                        })
                })
        }

        function createChildFromtemplate(witClient, service, currentWorkItem, template, teamSettings) {
            return function () {
                return getTemplate(template.id).then(function (taskTemplate) {
                    // Create child 
                    if (IsValidTemplate(currentWorkItem, taskTemplate)) {
                        createWorkItem(service, currentWorkItem, taskTemplate, teamSettings)
                    }
                });;
            };
        }

        function IsValidTemplateWIT(currentWorkItem, taskTemplate) {

            var filters = taskTemplate.description.match(/[^{\}]+(?=})/g);
            if (filters) {
                var isValid = false;
                for (var i = 0; i < filters.length; i++) {
                    var found = filters[i].split(',').find(function(f) { return f.trim() == currentWorkItem["System.WorkItemType"]});
                    if (found){
                        isValid = true;
                        break;
                    }
                }
                return isValid;
            } else {
                return true;
            }

        }

        function findWorkTypeCategory(categories, workItemType) {
            for (category of categories) {
                var found = category.workItemTypes.find(function (w) { return w.name == workItemType; });
                if (found != null) {
                    return category;
                }
            }
        }

        function GetChildTypes(witClient, workItemType) {

            console.log('GetChildTypes')

            return witClient.getWorkItemTypeCategories(VSS.getWebContext().project.name)
                .then(function (response) {
                    var categories = response;

                    var category = findWorkTypeCategory(categories, workItemType);

                    if (category != null) {

                        if (category.referenceName == 'Microsoft.EpicCategory') {
                            return witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.FeatureCategory')
                                .then(function (response) {
                                    var category = response;

                                    return category.workItemTypes.map(function (item) { return item.name });
                                });
                        }
                        if (category.referenceName == 'Microsoft.FeatureCategory') {

                            var requests = [];
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.RequirementCategory'))
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.BugCategory'))

                            return Q.all(requests)
                                .then(function (response) {
                                    var categories = response;

                                    var result = [];
                                    categories.forEach(function (category) {
                                        category.workItemTypes.forEach(function (workItemType) {
                                            result.push(workItemType.name);
                                        });
                                    });
                                    
                                    return result;
                                });
                        }
                        if (category.referenceName == 'Microsoft.RequirementCategory') {
                            return ['Task']
                        }
                        if (category.referenceName == 'Microsoft.BugCategory') {
                            return ['Task']
                        }
                        if (category.referenceName == 'Microsoft.TaskCategory') {
                            return ['Task']
                        }

                    }
                });

            //"Microsoft.EpicCategory"
            //"Microsoft.FeatureCategory"
            //Microsoft.RequirementCategory
            //Microsoft.BugCategory
            /*
                        if (workItemType == 'Epic') {
                            return ['Feature']
                        }
                        if (workItemType == 'Feature') {
                            return ['Product Backlog Item', 'User Story', 'Requirement', 'Bug']
                        }
                        if (workItemType == 'Product Backlog Item') {
                            return ['Task']
                        }
                        if (workItemType == 'User Story') {
                            return ['Task']
                        }
                        if (workItemType == 'Requirement') {
                            return ['Task']
                        }
                        if (workItemType == 'Bug') {
                            return ['Task']
                        }
                        if (workItemType == 'Task') {
                            return ['Task']
                        }
                        */
            // WriteLog(workItemType + ' not supported.')
            //  return null;
        }

        function ShowDialog(message) {

            var dialogOptions = {
                title: "1-Click Child-Links",
                width: 300,
                height: 200,
                resizable: false,
            };

            VSS.getService(VSS.ServiceIds.Dialog).then(function (dialogSvc) {

                dialogSvc.openMessageDialog(message, dialogOptions)
                    .then(function (dialog) {
                        //
                    }, function (dialog) {
                        //
                    });
            });
        }

        function SortTemplates(a, b) {
            var nameA = a.name.toLowerCase(), nameB = b.name.toLowerCase();
            if (nameA < nameB) //sort string ascending
                return -1;
            if (nameA > nameB)
                return 1;
            return 0; //default return value (no sorting)
        };

        function WriteLog(msg) {
            console.log('1-Click Child-Links: ' + msg);
        }

        return {

            create: function (context) {

                ctx = VSS.getWebContext();

                getWorkItemFormService().then(function (service) {
                    service.hasActiveWorkItem()
                        .then(function success(response) {
                            if (response == true) {
                                //form is open
                                AddTasksOnForm(service);
                            }
                            else {
                                // on grid
                                if (context.workItemIds && context.workItemIds.length > 0) {

                                    context.workItemIds.forEach(function (workItemId) {
                                        AddTasksOnGrid(workItemId);
                                    });
                                }
                                else if (context.id) {
                                    var workItemId = context.id;
                                    AddTasksOnGrid(workItemId);
                                }
                            }
                        });
                })
            },
        }
    });